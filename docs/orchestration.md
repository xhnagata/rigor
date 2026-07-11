# Model routing and orchestration

## Scope

Rigor separates model orchestration from deterministic control. The TypeScript CLI validates routing inputs, applies repository policy, excludes ineligible candidates, and previews a selection. It does not invoke Claude, Codex, or another model. Claude Code skills and agents will remain the execution layer in later phases.

Phase 1 provides `rigor route --dry-run`. It is advisory and creates no evidence artifact. A selected candidate does not authorize transmission, satisfy verification, or replace human approval.

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

The planned optional Codex integration uses [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), not a Rigor-owned Codex runtime. Normal review and adversarial review use the plugin's read-only flows. Consultation or rescue can use its subagent, but prompt-level read-only instructions are not an enforcement boundary. Rigor must compare tree hashes and changed paths before and after consultation and treat unexpected mutation as failure.

External job, session, turn, model, effort, and usage identifiers are optional because the plugin exposes different metadata for review jobs and synchronous subagent consultations. Absolute paths in findings must be normalized to repository-relative paths before persistence.

## Schemas

- `routing-input.v1.schema.json` describes the explicit task assessment and budget.
- `model-profiles.v1.schema.json` describes available candidates without asserting their real availability.
- `routing-decision.v1.schema.json` describes dry-run output and exclusion reason codes.
- `attempt.v1.schema.json` reserves the append-only execution-attempt format for the next phase.
- `consultation.v1.schema.json` reserves the normalized consultation summary. It stores no raw transcript or chain of thought.

Attempt and consultation persistence and automatic model invocation are not implemented in Phase 1.

## Example

```sh
rigor route --dry-run \
  --preflight .rigor/evidence/APP-123/preflight.json \
  --input /tmp/routing-input.json \
  --profiles /tmp/model-profiles.json
```

The command exits `0` when it selects a candidate, `2` when policy, capability, purpose, or budget leaves the task unroutable, and `3` for malformed or mismatched inputs.
