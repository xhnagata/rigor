# Evaluation benchmark and routing calibration

Rigor routes work to a capability class with a deterministic, testable
heuristic ([orchestration guide](orchestration.md#capability-derivation)). That
heuristic was designed before any outcome data existed. This document defines a
representative, contamination-aware evaluation process that compares capability
choices by the total cost of **accepted changes** and proposes routing changes
from evidence — without ever invoking a model from the CLI and without granting
any proposal enforcement authority.

The scope here is deliberately narrow. It is **not**:

- running every production task on every model;
- optimizing only API token price (the routing `relativeCost` is an abstract
  configured weight, never a price, token count, or verified charge);
- claiming statistical confidence from a tiny sample;
- automatically merging or applying any calibration change.

Every routing-policy change requires human review. The CLI never invokes a
model.

## Artifacts and commands

| Artifact / command                    | Schema                                                                                     | Role                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `rigor.evaluation-manifest.v1`        | [schema](../schemas/evaluation-manifest.v1.schema.json)                                    | Versioned, split-labelled task set (input document)                      |
| `rigor eval-report`                   | `rigor.evaluation-report.v1` ([schema](../schemas/evaluation-report.v1.schema.json))       | Joins the manifest to recorded evidence and reports accepted-change cost |
| `rigor eval-replay`                   | `rigor.evaluation-replay.v1`                                                               | Shadow re-run of routing selection under a proposed model-profiles file  |
| `rigor.calibration-proposal-input.v1` | [schema](../schemas/calibration-proposal-input.v1.schema.json)                             | Human-authored proposal input (distinct from the saved artifact)         |
| `rigor calibration-proposal`          | `rigor.calibration-proposal.v1` ([schema](../schemas/calibration-proposal.v1.schema.json)) | Inert, human-review-required proposal                                    |

```sh
rigor eval-report   --manifest <manifest.json> --evidence-root <dir> [--out <file>]
rigor eval-replay   --manifest <manifest.json> --evidence-root <dir> \
                    --profiles <proposed-model-profiles.json> [--holdout-final]
rigor calibration-proposal --manifest <manifest.json> --input <proposal-input.json> \
                    --report <report-or-replay.json> [--report <file> ...]
```

The evidence root is resolved once to its real path; any task directory or file
that resolves outside that root (for example through a symlink out of the tree)
is never read and is counted as one malformed outcome. The root itself may live
anywhere — an explicitly selected external fixture root is supported — since
containment is measured relative to the resolved root.

`--evidence-root` is the directory that directly contains one subdirectory per
task id (for this repository, `.rigor/evidence`). Reports are joined from that
tree only; they never embed an absolute path.

## Task categories and the manifest

The manifest defines its own bounded `categories` list (at most 32) and labels
each task with a `split` of `calibration` or `holdout`. Categories used for the
dogfooding set:

- **bugfix** — a localized defect fix with strong verification.
- **feature** — a bounded new capability, usually multi-file.
- **refactor** — behavior-preserving restructuring under existing tests.
- **docs** — documentation and specification changes.
- **infra/ops** — CI, release, and repository plumbing.
- **schema** — additive artifact/schema evolution with parser and test changes.

Each task entry carries a `source` description, an optional repository-relative
`fixtureRef` (an isolated worktree/fixture used for a documented cross-model
comparison — a manifest field and process record, never live execution), and an
optional `crossModelComparison` flag. `manifestVersion` is an integer that is
bumped whenever the task set changes materially.

### Initial 10-20 task set

The initial calibration/holdout set is drawn from this repository's own
dogfooding history (`GH-2 … GH-24`, plus release and ops tasks) so the
evaluation reflects real, verified work rather than synthetic prompts. A
representative starting selection:

| Task      | Category  | Split       |
| --------- | --------- | ----------- |
| GH-2      | schema    | calibration |
| GH-6      | feature   | calibration |
| GH-8      | feature   | calibration |
| GH-9      | feature   | holdout     |
| GH-10     | refactor  | calibration |
| GH-11     | feature   | calibration |
| GH-12     | feature   | holdout     |
| GH-13     | bugfix    | calibration |
| GH-14     | feature   | calibration |
| GH-15     | feature   | calibration |
| GH-21     | docs      | holdout     |
| GH-22     | schema    | calibration |
| GH-24     | feature   | calibration |
| REL-0-8-0 | infra/ops | holdout     |

A **runnable** synthetic example of the whole flow lives under
[`test/fixtures/evaluation/`](../test/fixtures/evaluation) with a manifest, a
synthetic evidence tree, a checked-in expected report and replay, and an example
proposal. `test/evaluation.test.ts` regenerates the report from those fixtures
and asserts it deterministically; no live model is invoked.

### Expansion to 30-100

Grow the set toward 30-100 tasks by adding **newly completed** tasks to the
**calibration** split as they merge. Holdout tasks are frozen: they are never
moved into calibration and never used to fit thresholds. When a detector or
model-profile version changes, treat existing evidence as a prior stratum and
begin a fresh stratum rather than mixing incomparable runs. The manifest's
`expansionPolicy` field records this rule in-band.

## What the report measures

`rigor eval-report` joins each manifest task's `.rigor/evidence/<taskId>/`
artifacts (`outcome.json`, `attempts/attempt_*.json`, `routing/routing-plan_*.json`)
and emits per-split aggregates. It never throws on a missing or malformed file;
it counts it, exactly like [`retrospect`](orchestration.md#outcome-and-retrospect-metrics)
counts `malformedOutcomes`.

- **Accepted changes are the denominator.** Every per-accepted-change rate
  (`retries`, `configuredRelativeCost`, `humanCorrectionMinutes`,
  `reviewFindings`, `elapsedMs`) is denominated by accepted changes and is
  `null` when there are none. `elapsedMs` is additionally `null` unless elapsed
  is present for **every** accepted change in the aggregate (`elapsedMissing`
  is 0); a partial mean is never emitted as if it were complete.
- **Missing data is shown, never guessed.** `outcomes` reports accepted,
  rejected, absent (a manifest task with no outcome), and malformed counts.
  `missingData` reports usage status, model-identity presence/absence,
  provider-cost presence, elapsed presence/missing, attempt and verification
  linkage, malformed artifact counts, and `relativeCostUnknownAttempts` (an
  attempt whose routing plan could not be resolved, or an attempt itself
  excluded as malformed — both counted, never inferred, so a task with one
  valid and one malformed attempt reports an unknown cost, not the valid
  attempt's cost standing in for the whole task).
  An artifact whose `schemaVersion` matches but whose consumed fields are
  wrong-typed (for example a string `retryCount`, a non-object attempt
  `progress`, or a non-numeric `selection.relativeCost`) — or that is missing a
  field its own schema requires the report to consume (for example an absent
  `retryCount`, `escalationCount`, `humanCorrectionMinutes`, `reviewFindings`,
  `usage`, or `escapedDefectStatus` on an outcome; an absent `artifactId` on a
  routing plan; or an absent `routingPlanArtifactId` on an attempt) — is not
  trusted on the version alone: it is counted as malformed
  (`outcomes.malformed`, `malformedArtifacts`) and excluded from aggregation
  rather than silently defaulted or accepted. Fields the schema leaves
  optional (for example `attemptDurationMs`, `provider`, `model`) remain
  legitimately absent and contribute to `missingData` instead. A collection
  directory (`attempts/`, `routing/`) that escapes the resolved evidence root
  is likewise never read and counts as one malformed artifact, exactly like an
  escaping individual file or an escaping task directory — never as zero.
- **Capability classes are comparable.** `byCapabilityClass` always lists all
  four classes (`economy`, `standard`, `premium`, `frontier`) with their
  aggregated `configuredRelativeCost`, so a change can be compared across
  classes. `configuredRelativeCost` is an abstract configured weight, never a
  price, token count, or verified charge. When any contributing attempt's plan
  is unresolved (`relativeCostUnknownAttempts` > 0), the per-accepted-change
  `configuredRelativeCost` is `null` and only the known numerator
  (`configuredRelativeCostTotal`) is reported, so a partial total never reads as
  complete or as zero.
- **Candidates are keyed compositely.** `byCandidate`'s internal aggregation
  key is `JSON.stringify([provider, model, capabilityClass])` (falling back to
  the literal string `unlinked` for an outcome with no linked attempt), so two
  distinct candidates that share a model name never collapse into one row.
  This deliberately deviates from
  [`retrospect`](orchestration.md#outcome-and-retrospect-metrics), which keys
  per-candidate metrics by model name alone. A delimiter-joined string (for
  example `provider/model/class`) is not used: a provider or model name that
  itself contains `/` (for example provider `a/b`, model `c`) would collide
  with a different candidate (provider `a`, model `b/c`) under naive joining,
  since both read `a/b/c/standard`. JSON's quoting and comma-separation keep
  such tuples distinct (`["a/b","c","standard"]` vs `["a","b/c","standard"]`).
  The reported `candidate` field carries this same JSON.stringify tuple; use
  the sibling `provider`, `model`, and `capabilityClass` fields for a
  human-readable identification of the row.
- **Over-routing** is a reviewable heuristic count: accepted on the first
  attempt (retryCount 0, escalationCount 0) with zero review findings at a class
  above economy, so a lower class may have sufficed. It is a signal for review,
  not a verdict; the definition ships inside the report.
- **Under-routing** is a reviewable heuristic count: an outcome at the routed
  class that was rejected, escalated, or produced an expanded failure set. Its
  denominator is accepted + rejected outcomes.
- **Retry cost** reports retries and the configured relative cost consumed
  across every recorded attempt per accepted change, with unresolved attempts
  counted separately.
- **Escaped defects** are read from `outcome.escapedDefectStatus`
  (`suspected`/`confirmed`) with accepted changes as the denominator.

All aggregates are split into `calibration` and `holdout`, and the holdout
section is marked `evaluationOnly: true`.

## Contamination rules

1. **Holdout tasks never fit thresholds.** They are aggregated for reporting
   only and marked evaluation-only. `rigor eval-replay` operates on the
   calibration split by default and can never mix splits in one output.
2. **New-session isolation.** Evaluation reads only committed evidence
   artifacts; it does not re-run tasks or reuse a live session's context.
3. **Isolated worktrees/fixtures for cross-model comparisons.** A selected
   cross-model comparison is documented via `fixtureRef`/`crossModelComparison`
   and run in an isolated worktree/fixture. This is a documented process and a
   manifest field, not live CLI execution.
4. **No live multi-model runs without a human-approved budget.** The CLI never
   invokes a model; any multi-model comparison is a separate, explicitly
   approved, human-run experiment.

## Replay / shadow evaluation

`rigor eval-replay` re-runs the pure routing selector over each recorded routing
plan with a **proposed** `model-profiles` file and reports which tasks would
route differently. It sources the required capability class, purpose, budget,
external-transmission control, and assessment confidence from the recorded plan;
because the required class is a function of the task's signals only, it is
unchanged by a proposed profile, so the recorded value is exact. The output
lists per-task `original` vs `proposed` selections and a summary of changed,
unchanged, `nowUnroutable`, and `nowRequiresReview` counts. A selection counts
as `changed` when the outcome status differs or when any observable of the
selection differs — the candidate id, its capability class, or its configured
relative cost — so re-weighting a candidate's `relativeCost` while keeping the
same id is reported as a change, not a no-op.

Holdout separation is enforced by construction: without `--holdout-final` the
replay considers the **calibration** split only; with `--holdout-final` it
considers the **holdout** split only and records `holdoutFinal: true` and
`split: "holdout"` in the output. The two splits can never appear in one replay,
so a proposed change can never be fit against holdout tasks. If the selected
split has no task with a recorded routing plan, the command fails closed with
exit `2`.

## Proposing a routing change

`rigor calibration-proposal` reads a human-authored
`rigor.calibration-proposal-input.v1` (its own schema version, distinct from the
saved artifact) and appends a `rigor.calibration-proposal.v1` under
`.rigor/evidence/<taskId>/calibration/`. The command **requires** `--manifest`
and cross-checks every `evidence.taskId` against it: an evidence task absent
from the manifest is rejected fail-closed, and a **holdout** evidence task is
rejected unless the input sets `holdoutFinalEvaluation: true` to mark the
citation as a deliberate final-evaluation reference. The CLI generates the
`artifactId`, `createdAt`, and a `provenance` block that records the manifest
hash and the split of every cited evidence task, so a proposal's contamination
boundary is auditable. A proposal names its `target` (`model-profiles`,
`escalation-thresholds`, or `routing-heuristic-constant`), its `evidence`
(report hashes, task ids, and an optional replay hash), `expectedTradeOffs`, and
`rollbackCriteria`. It is inert: `status` is always `proposed` and
`approvalEffect` always `none`, and the parser rejects any other value. No Rigor
code path reads a proposal to change routing, thresholds, or profiles; applying
one is a human edit to the model-profiles or escalation
thresholds, reviewed like any other change.

### Evidence hashes are verified, never copied unverified

`evidence.reportHashes` and `evidence.replayHash` are claims about specific
report/replay files; the command never trusts them unverified. `rigor
calibration-proposal` **requires** one or more repeated `--report <file>`
arguments (a `rigor eval-report` output, a `rigor eval-replay` output, or both).
Every supplied `--report` file must:

1. parse as a `rigor.evaluation-report.v1` or `rigor.evaluation-replay.v1`
   document (any other or missing `schemaVersion` is rejected fail-closed);
2. carry a `manifest.hash` that equals the hash of the `--manifest` selected
   for this command — the same manifest `evidence.taskId`s are cross-checked
   against — so a report generated from a different manifest can never be
   cited as evidence for this one.

Every digest in `evidence.reportHashes` must equal the **canonical hash** of
one supplied `rigor.evaluation-report.v1` file, and `evidence.replayHash`
(when not `null`) must equal the canonical hash of one supplied
`rigor.evaluation-replay.v1` file. The canonical hash is computed by the same
`hash()` helper the report/replay generators use for their own embedded
hashes (`manifest.hash`, `proposedModelProfilesHash`): it re-serializes the
**parsed** JSON object through a stable, sorted-object-key stringify before
hashing with SHA-256, so it is exactly reproducible from the parsed document
regardless of on-disk formatting (pretty-printing, key order, or a trailing
newline) and reflects only content. Any mismatch — an unrecognized
schemaVersion, a manifest-hash mismatch, or a digest with no backing supplied
file — fails closed as an input error: a proposal can never cite evidence
nobody actually supplied. The checked-in
[`test/fixtures/evaluation/expected-report.json`](../test/fixtures/evaluation/expected-report.json)
is itself a valid `--report` file for
[`test/fixtures/evaluation/manifest.json`](../test/fixtures/evaluation/manifest.json),
since its `manifest.hash` matches that manifest and
`proposal-input.json`'s `evidence.reportHashes` is its canonical hash.

## Human review, owner, and interval

Changing routing policy requires human review. The evaluation set names a
recurring **calibration owner** — the repository owner (see
[CODEOWNERS](../CODEOWNERS)) — who is responsible for reviewing the report,
any replay, and any proposal. The **review interval** is **every release**: at
each release the owner regenerates the report over the current evidence,
reviews outstanding proposals, and either applies a change by hand or records
why not. Both the owner and the interval are also recorded in the manifest
(`owner`, `reviewInterval`).

## Interaction with #22 test-integrity strata

Test-integrity shadow evidence joins evaluation by task id. Only the TI-05…TI-09
collector at version `0.1.0` exists today
([test-integrity.md](test-integrity.md#interaction-with-16-outcome-based-calibration)),
so those five signals are the only strata available. Treat any detector-version
change as a new stratum, and prefer committed-`headSha` events over dirty
worktree previews when joining, since a worktree scan sees tracked files only.
Precision estimates from that evidence are inputs to a future enforcement
proposal, never an enforcement gate.
