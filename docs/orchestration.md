# Model routing and orchestration

## Scope

Rigor separates model orchestration from deterministic control. The TypeScript CLI validates routing inputs, applies repository policy, excludes ineligible candidates, and previews a selection. It does not invoke Claude, Codex, or another model. Claude Code skills and agents will remain the execution layer in later phases.

Phase 1 provides `rigor route --dry-run`. It is advisory and creates no evidence artifact. A selected candidate does not authorize transmission, satisfy verification, or replace human approval. Phase 2 adds an append-only, policy-gated consultation protocol for `codex-plugin-cc`. Phase 3 binds a recorded routing plan to the contract and brackets each Claude or Codex implementation with an append-only attempt session and result.

The dry-run result hashes the preflight, routing input, and model profiles so the exact inputs can be compared without embedding their prose in later summaries.

## Inputs and facts

Routing deliberately keeps two kinds of input separate:

| Source          | Fields                                                                                             | Trust treatment                                                        |
| --------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Rigor preflight | risk tier, transmission decision, protected paths, approval requirement                            | deterministically derived from policy, paths, and Git facts            |
| routing input   | complexity, ambiguity, novelty, verification strength, assessment reasons                          | explicit assessment that can be wrong and must remain reviewable       |
| model profiles  | provider, capability class, supported purposes, relative cost, additional-transmission requirement | configured operational input, not a claim of model identity or quality |

Risk is impact if a change is wrong. Capability is the estimated ability needed to perform the task. They are not interchangeable: a small security configuration change can be high risk but mechanically simple, while a low-impact algorithm experiment can be difficult.

## Capability derivation

The selector maps `low`, `medium`, `high`, and `critical` assessment levels to `economy`, `standard`, `premium`, and `frontier`. It takes the maximum of complexity, ambiguity, and novelty. Weak deterministic verification raises the required class by one, capped at frontier.

This is an initial, testable heuristic rather than an empirical quality claim. Later calibration must be based on accepted-change cost, retries, elapsed time, human intervention, review findings, and escaped defects.

Every routing input includes at least one assessment reason. These reasons make the model- or human-supplied classification reviewable, but they do not turn an assessment into a deterministic fact.

## Candidate filtering and selection

Candidates are considered in this order:

1. reject disabled candidates;
2. reject candidates that do not support the requested purpose;
3. when preflight denies transmission, reject candidates requiring additional external transmission;
4. reject candidates below the required capability class;
5. reject candidates above the task's relative-cost budget;
6. select the remaining candidate with the lowest relative cost, then the least excess capability, then lexicographic candidate ID.

`relativeCost` is a configured comparison weight. It is not a price, invoice, token count, or verified provider charge. Unknown model, effort, usage, and cost data must remain unknown instead of being inferred from a display name.

## Claude and Codex

Claude Code is the required execution environment. Claude candidates normally set `requiresAdditionalExternalTransmission` to `false` because they remain in the already active Claude Code execution boundary. A `codex-plugin-cc` candidate sets it to `true`, so it is excluded when repository policy denies transmission to an additional external provider.

The optional Codex integration uses [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), not a Rigor-owned Codex runtime. Normal review and adversarial review use the plugin's read-only flows. Consultation or rescue can use its subagent, but prompt-level read-only instructions are not an enforcement boundary. Rigor compares content-sensitive tree hashes, HEAD, and changed paths before and after consultation and treats unexpected mutation as failure.

External job, session, turn, model, effort, and usage identifiers are optional because the plugin exposes different metadata for review jobs and synchronous subagent consultations. Absolute paths in findings must be normalized to repository-relative paths before persistence.

## Schemas

- `routing-input.v1.schema.json` describes the explicit task assessment and budget.
- `model-profiles.v1.schema.json` describes available candidates without asserting their real availability.
- `routing-decision.v1.schema.json` describes dry-run output and exclusion reason codes.
- `routing-plan.v1.schema.json` binds a selected decision to the preflight, contract, policy, profiles, and HEAD.
- `attempt-session.v1.schema.json` records the selected candidate, budgets, and pre-execution Git state.
- `attempt-result-input.v1.schema.json` records completion, failure, cancellation, and available external IDs.
- `attempt.v1.schema.json` records duration, before/after state, scope violations, and linked passing verification.
- `consultation-request.v1.schema.json` bounds the decision sent to `codex-plugin-cc`.
- `consultation-session.v1.schema.json` records the pre-consultation Git snapshot.
- `consultation-result-input.v1.schema.json` accepts a minimal normalized result without raw transcript or chain of thought.
- `consultation.v1.schema.json` links the session and result and records the post-consultation mutation check.

Model execution remains a Claude Code Skill responsibility rather than a TypeScript CLI action. Provider/model identity is recorded as `unverified`: configuration and an agent's report do not attest which runtime served the request.

## Example

```sh
rigor route --dry-run \
  --preflight .rigor/evidence/APP-123/preflight.json \
  --input /tmp/routing-input.json \
  --profiles /tmp/model-profiles.json
```

The command exits `0` when it selects a candidate, `2` when policy, capability, purpose, or budget leaves the task unroutable, and `3` for malformed or mismatched inputs.

To persist a plan for execution, replace `--dry-run` with `--record` and add the linked contract:

```sh
rigor route --record \
  --preflight .rigor/evidence/APP-123/preflight.json \
  --contract .rigor/evidence/APP-123/contract.json \
  --input /tmp/routing-input.json \
  --profiles /tmp/model-profiles.json
```

## Attempt protocol

Start immediately before invoking the selected Claude or Codex implementation agent:

```sh
rigor attempt-start \
  --plan .rigor/evidence/APP-123/routing/routing-plan_ID.json \
  --contract .rigor/evidence/APP-123/contract.json
```

After the agent returns, run `rigor verify --dry-run`. Failed attempts are finalized without consuming the task's write-once `verification.json`. When a dry-run passes and the attempt is accepted, run normal `rigor verify` once and finalize with that saved artifact. Finalize every started attempt, including failures:

```sh
rigor attempt-finish \
  --session .rigor/evidence/APP-123/attempts/attempt-session_ID.json \
  --contract .rigor/evidence/APP-123/contract.json \
  --input /tmp/attempt-result.json \
  --verification .rigor/evidence/APP-123/verification.json
```

`completed` requires a passing, task- and contract-linked verification artifact. Scope or duration violations override the model-supplied status and exit `2`. Only one unfinished attempt is allowed per task, and the recorded plan's `maxAttempts` is enforced locally. Attempt concurrency is not supported.

## Consultation protocol

Start a consultation before invoking Codex:

```sh
rigor consult-start \
  --preflight .rigor/evidence/APP-123/preflight.json \
  --input /tmp/consultation-request.json
```

`consult-start` rejects a stale policy hash, a changed HEAD, paths outside the preflight scope, or denied external transmission. If the implementation scope changed, create a fresh preflight before consultation.

After `codex-plugin-cc` returns, normalize only its outcome, finding count, required actions, and available external IDs, then finish:

```sh
rigor consult-finish \
  --session .rigor/evidence/APP-123/consultations/consultation-session_ID.json \
  --input /tmp/consultation-result.json
```

Both the session and final result are append-only. Evidence files and the local event log are excluded from the before/after content hash so recording the session does not report itself as a mutation. Any other content change, changed path, or HEAD change makes `consult-finish` exit `2` with `status: "mutated-worktree"`.
