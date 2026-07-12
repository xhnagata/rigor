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
| routing input   | complexity, ambiguity, novelty, verification strength, assessment reasons or evidence              | explicit assessment that can be wrong and must remain reviewable       |
| model profiles  | provider, capability class, supported purposes, relative cost, additional-transmission requirement | configured operational input, not a claim of model identity or quality |

Risk is impact if a change is wrong. Capability is the estimated ability needed to perform the task. They are not interchangeable: a small security configuration change can be high risk but mechanically simple, while a low-impact algorithm experiment can be difficult. Introducing an explicit assessment confidence in `rigor.routing-input.v2` does not change this: confidence and evidence inform whether the _capability_ assessment is trustworthy enough to act on, never the risk tier itself.

### Assessment confidence and evidence (schema version `rigor.routing-input.v2`)

`rigor.routing-input.v2` replaces the flat `assessmentReasons` list with a structured `assessment` object: `confidence` (`low`, `medium`, or `high`) and `evidence` (one to twenty entries, each anchoring an `observation` to a repository-relative `path`).

Two things this is deliberately _not_:

- `confidence` is an explicit, reviewable judgment supplied by the model or human doing the assessment. It is not a calibrated probability, and Rigor does not calibrate it against outcomes before acting on it.
- `evidence` anchors each observation to a path so a reviewer knows where to look. Rigor validates that the path is a well-formed, repository-relative string; it does not read the file, run the observation, or otherwise verify that the claimed observation is true. Evidence keeps an assessment reviewable — it does not turn the assessment into a deterministic fact.

Routing fails closed, deterministically, in these cases:

- **Malformed input**: an evidence entry missing `path` or `observation`, an out-of-range `confidence`, or any field that fails basic structural validation.
- **Unsupported schema**: any `schemaVersion` other than `rigor.routing-input.v1` or `rigor.routing-input.v2`.
- **Evidence-free**: `assessment.evidence` missing or empty. A confidence claim with nothing anchoring it is rejected outright rather than accepted with zero evidence.
- **Contradictory assessment**: `confidence: "high"` together with `ambiguity: "critical"` or `verificationStrength: "weak"`. A task cannot simultaneously be maximally ambiguous, or unverifiable by deterministic means, and be assessed with high confidence.

When parsing succeeds and `confidence` is `"low"`, `rigor route` never silently falls back to selecting the cheapest (economy-class) candidate. It always returns `status: "requires-review"` with `selection: null`, regardless of whether an eligible candidate exists, and exits `2`. Candidate filtering and exclusion reasons are still computed and reported so a reviewer sees the full picture; `createRoutingPlan` refuses to turn a `requires-review` (or `unroutable`) decision into a plan.

**v1 migration path**: `rigor.routing-input.v1` inputs remain fully accepted, unchanged. A v1 input has no `assessment` field, so routing treats it as legacy `confidence: "medium"` with zero evidence — the same behavior as before this schema version existed. Routing plans recorded before this change carry no `assessment` summary at all; `parseRoutingPlan` synthesizes the same legacy default (`inputSchemaVersion: "rigor.routing-input.v1"`, `confidence: "medium"`, `evidenceCount: 0`) rather than rejecting an evidence file that was valid when it was written.

### Producing `rigor.routing-input.v2` with `/rigor:assess`

`/rigor:assess` lets an autonomous `/rigor:orchestrate` flow obtain a `rigor.routing-input.v2` without a human authoring it by hand. It reads only the task statement plus the repository files, tests, and schemas the task names, judges `signals` and `assessment.confidence` from what it read, and anchors every signal judgment to at least one repository-relative-path `evidence` entry. It reports task characteristics only: it never names or selects a model, and evidence observations must state facts (`"file X hard-codes Y"`), never conclusions like "use model Z" — `rigor route` remains the sole place a candidate is chosen.

Before the produced input is ever passed to `rigor route --record`, `/rigor:assess` validates it with `rigor route --dry-run`, exactly like any other routing input: exit `3` (malformed, unsupported, evidence-free, or contradictory) is fixed only if the assessment itself contained a factual error, never by loosening signals or confidence; exit `2` (`requires-review` from low confidence, or `unroutable`) is a stop that hands the assessment to a human, not a retry with adjusted signals. The same fail-closed gates documented above — evidence-free, contradictory, and low-confidence — apply identically whether the input was authored by a human or produced by `/rigor:assess`.

## Capability derivation

The selector maps `low`, `medium`, `high`, and `critical` assessment levels to `economy`, `standard`, `premium`, and `frontier`. It takes the maximum of complexity, ambiguity, and novelty. Weak deterministic verification raises the required class by one, capped at frontier.

This is an initial, testable heuristic rather than an empirical quality claim. Later calibration must be based on accepted-change cost, retries, elapsed time, human intervention, review findings, and escaped defects.

Every routing input includes at least one assessment reason (v1) or at least one piece of path-anchored evidence (v2). These make the model- or human-supplied classification reviewable, but they do not turn an assessment into a deterministic fact. See "Assessment confidence and evidence" above for the v2 confidence gate and its fail-closed cases.

## Candidate filtering and selection

Candidates are considered in this order:

1. reject disabled candidates;
2. reject candidates observed as `incompatible` or `unavailable` when an availability report is supplied (see below);
3. reject candidates that do not support the requested purpose;
4. when preflight denies transmission, reject candidates requiring additional external transmission;
5. reject candidates below the required capability class;
6. reject candidates above the task's relative-cost budget;
7. select the remaining candidate with the lowest relative cost, then the least excess capability, then lexicographic candidate ID.

`relativeCost` is a configured comparison weight. It is not a price, invoice, token count, or verified provider charge. Unknown model, effort, usage, and cost data must remain unknown instead of being inferred from a display name.

Selection is deterministic and every excluded candidate is recorded with its reason code, so choosing the next eligible candidate is not a silent substitution. When availability, capability, purpose, transmission, or budget leaves no candidate, the decision is `unroutable` and the command exits `2`; the router never quietly swaps in a model the caller did not select.

## Availability, configured identity, and attested identity

Rigor distinguishes three separate ideas and never conflates them:

- **Availability** is an _observation_ of whether the current Claude Code / `codex-plugin-cc` environment can invoke a configured candidate. It is not attestation.
- **Configured identity** is what the profile or Claude Code configuration _claims_ the model is (for example `ANTHROPIC_MODEL`). It is always recorded as `unverified`.
- **Attested identity** — cryptographic proof of which runtime actually served a request — is _not provided_ by Rigor and remains a documented gap.

`rigor availability --profiles <file>` produces a versioned `rigor.availability.v1` report that marks each configured candidate as exactly one of `available`, `unavailable`, `unknown`, or `incompatible`. Probing reads only documented, bounded local interfaces — a fixed set of environment variables (`CLAUDE_PLUGIN_ROOT`/`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_VERSION`, `ANTHROPIC_MODEL`, `RIGOR_CODEX_PLUGIN_PRESENT`, `RIGOR_CODEX_PLUGIN_VERSION`). It performs no installation, authentication, network transmission, or scraping of undocumented UI, so it is never a claim that the selected model exists, was invoked, or has any quality, effort, usage, or cost.

These variables do not all have the same provenance. The Claude Code variables are set by Claude Code itself, but `RIGOR_CODEX_PLUGIN_PRESENT`/`RIGOR_CODEX_PLUGIN_VERSION` are a declaration channel: the orchestrator (typically a model-driven agent) sets them after observing the plugin through Claude Code's own documented plugin listing, and the report records that declaration, not a direct plugin observation. A wrong declaration can exclude codex candidates (`absent`) or mark them `available` (`present`), but it never bypasses the external-transmission policy gate, never invokes anything by itself, and never turns configured identity into attested identity; an unrecognized or missing declaration stays `unknown`.

State derivation:

- `available` — the environment was positively observed to support the candidate (Claude Code present for a `claude` candidate; `codex-plugin-cc` declared present for a Codex candidate).
- `unavailable` — a supported provider was positively declared or observed to be missing (for example `codex-plugin-cc` declared absent). Missing `codex-plugin-cc` excludes only candidates that require it.
- `incompatible` — the provider cannot be invoked by the Claude Code execution layer at all (anything other than `claude` or `codex-plugin-cc`). This is a static property of the provider type, so it is derived even when probing is unsupported.
- `unknown` — probing is unsupported, failed, changed format, or the signal was simply not observable. Unknown is never treated as available and never excludes a candidate: the flow fails safe by leaving the candidate eligible under the remaining deterministic filters, exactly as it would with no availability report at all.

Tool and plugin versions and the observation time are recorded when observable and represented as explicitly `null`/unknown otherwise; they are never fabricated. When `rigor route` is given `--availability`, the report's `modelProfilesHash` must match the profiles being routed, and the selected decision records an `availabilityReportHash` so the observation is traceable. Availability is an optional input: routing without a report behaves exactly as before.

## Claude and Codex

Claude Code is the required execution environment. Claude candidates normally set `requiresAdditionalExternalTransmission` to `false` because they remain in the already active Claude Code execution boundary. A `codex-plugin-cc` candidate sets it to `true`, so it is excluded when repository policy denies transmission to an additional external provider.

The optional Codex integration uses [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), not a Rigor-owned Codex runtime. Normal review and adversarial review use the plugin's read-only flows. Consultation or rescue can use its subagent, but prompt-level read-only instructions are not an enforcement boundary. Rigor compares content-sensitive tree hashes, HEAD, and changed paths before and after consultation and treats unexpected mutation as failure.

External job, session, turn, model, effort, and usage identifiers are optional because the plugin exposes different metadata for review jobs and synchronous subagent consultations. Absolute paths in findings must be normalized to repository-relative paths before persistence.

## Schemas

- `routing-input.v1.schema.json` describes the explicit task assessment (flat `assessmentReasons`) and budget.
- `routing-input.v2.schema.json` describes the explicit task assessment as a structured, path-anchored `confidence`/`evidence` object and budget.
- `model-profiles.v1.schema.json` describes configured candidates without asserting their real availability.
- `availability.v1.schema.json` describes an observed per-candidate availability report (available/unavailable/unknown/incompatible) with recorded tool/plugin version and observation time.
- `routing-decision.v1.schema.json` describes dry-run output, exclusion reason codes (including `UNAVAILABLE` and `INCOMPATIBLE`), the `requires-review` status, and the assessment summary (`inputSchemaVersion`, `confidence`, `evidenceCount`).
- `routing-plan.v1.schema.json` binds a selected decision to the preflight, contract, policy, profiles, and HEAD, and carries the same assessment summary (optional, for backward compatibility with plans recorded before `rigor.routing-input.v2`) plus the optional `availabilityReportHash`.
- `attempt-session.v1.schema.json` records the selected candidate, budgets, and pre-execution Git state.
- `attempt-result-input.v1.schema.json` records completion, failure, cancellation, and available external IDs.
- `attempt.v1.schema.json` records duration, before/after state, scope violations, linked passing verification, a Rigor-derived `failureFingerprint`/`failureCategory`/`failureFacts` copied from that verification, and a `progress` comparison against the most recent prior finished attempt.
- `escalation-decision-input.v1.schema.json` describes linked attempt facts, deterministic failure/progress facts, safety and human-decision gates, consumed budgets, configurable thresholds, and separately identified model-authored speculation.
- `escalation-decision.v1.schema.json` describes the deterministic retry/escalate/stop result, selected capability/candidate, every candidate exclusion, linked input hashes, and the remaining relative-cost budget.
- `consultation-request.v1.schema.json` bounds the decision sent to `codex-plugin-cc`.
- `consultation-session.v1.schema.json` records the pre-consultation Git snapshot.
- `consultation-result-input.v1.schema.json` accepts a minimal normalized result without raw transcript or chain of thought.
- `consultation.v1.schema.json` links the session and result and records the post-consultation mutation check.
- `outcome-input.v1.schema.json` bounds the human-reported disposition of a task.
- `outcome.v1.schema.json` links the outcome to its attempt, verification, and review and normalizes usage as measured-or-unavailable.

Model execution remains a Claude Code Skill responsibility rather than a TypeScript CLI action. Provider/model identity is recorded as `unverified`: configuration and an agent's report do not attest which runtime served the request. Availability probing observes only whether a candidate can be invoked; it does not raise configured identity to attested identity, and runtime model identity, reasoning effort, usage, and cost remain unverified/unknown unless an authoritative source is added later.

## Example

```sh
rigor route --dry-run \
  --preflight .rigor/evidence/APP-123/preflight.json \
  --input /tmp/routing-input.json \
  --profiles /tmp/model-profiles.json
```

The command exits `0` when it selects a candidate, `2` when policy, capability, purpose, or budget leaves the task unroutable (or a v2 input's low assessment confidence requires human review), and `3` for malformed, unsupported-schema, evidence-free, contradictory, or mismatched inputs.

To observe candidate availability before routing and let it filter unavailable or incompatible candidates, produce a report and pass it with `--availability`:

```sh
rigor availability --profiles /tmp/model-profiles.json > /tmp/availability.json
rigor route --dry-run \
  --preflight .rigor/evidence/APP-123/preflight.json \
  --input /tmp/routing-input.json \
  --profiles /tmp/model-profiles.json \
  --availability /tmp/availability.json
```

To persist a plan for execution, replace `--dry-run` with `--record` and add the linked contract (`--availability` may be combined with `--record`):

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

### Failure fingerprints and progress

`rigor verify` derives normalized failure facts for every configured check, passing or not, before its raw stdout/stderr is discarded: `src/fingerprint.ts` extracts a bounded `testStats` count (when a recognized `node:test` TAP summary or jest-like `Tests: N failed, M passed, T total` line is present), a `failure` (`category`, `errorClass`, normalized `failedTests`, and opaque `signatureDigest`/`fingerprint` hashes) for non-passing checks, and stores only these normalized facts plus digests on the `verification.json` artifact as `failureFacts` and a verification-wide `failureFingerprint`. No raw command output, path, timestamp, UUID, or hex identifier is ever persisted; normalization is deterministic and applied in a fixed order (documented at the top of `src/fingerprint.ts`) by a shared `applyNoiseMasks` helper: strip ANSI escapes; replace UUIDs, ISO-8601 timestamps and clock times, and durations with fixed placeholders; replace `0x`-prefixed hex literals, then file paths, with fixed placeholders (path masking runs before the standalone hex-run mask so a path segment that happens to be an 8+ character hex run still masks fully as `<path>` rather than partially as `/var/<hex>/...`); replace remaining standalone hex runs; collapse `:line:col` suffixes. `normalizeSignature` then trims and collapses whitespace, keeps only lines that look like failure signal (error/fail/expect/received/assert/"not ok"/check-or-cross marks/"at "), and caps and dedupes the result; `normalizeTestName` instead strips a trailing `(duration)` suffix, applies the same noise masks, and bounds each name to 200 characters before it is sorted, deduped, and persisted in `failedTests`. Two check runs whose only difference is a changed path, timestamp, UUID, hex ID, or duration hash identically, and a failed-test title carrying a per-run uuid/timestamp/path is masked (never stored raw) so it neither breaks fingerprint stability nor persists anything secret-shaped.

Failure categorization is conservative: `infrastructure` requires a specific, unambiguous signature — a Node.js network error code matched with word boundaries (e.g. `ECONNREFUSED`, `ETIMEDOUT`) or a specific phrase (`getaddrinfo`, `socket hang up`, `rate limit`, `Too Many Requests`, `network is unreachable`, `network error`) — never a bare word or number. A bare `network` or `429` substring inside an otherwise ordinary assertion (for example, `expected networkStatus to equal 2` or `expected HTTP 200 but got 429`) classifies as `implementation`, not `infrastructure`; matching bare substrings would both drop a genuine implementation failure out of loop detection and could let `compareFailures` misreport progress.

`rigor attempt-finish` copies the linked verification's `failureFingerprint`/`failureFacts` onto the attempt (`[]`/`null` when no verification is linked) and derives `failureCategory` (`implementation`, `infrastructure`, `timeout`, `mixed`, or `null`) from them. It then reads the most recently finished prior attempt for the task and records a `progress` comparison — `first` (no prior attempt, or the prior attempt predates failure fingerprinting), `unchanged` (the same implementation-category failures recur), `reduced` (see below), `expanded` (a new implementation-category check or test failed), or `incomparable` (anything else, including when a weakening signal fires). Infrastructure and timeout failures are categorized and compared separately from implementation failures and never confirm an "unchanged" implementation-failure loop on their own, so a flaky network dependency cannot masquerade as unresolved repeated implementation defect, nor can it hide one. `weakeningSignals` flag a dropped observed test total or a check that is no longer present in the verification relative to the prior attempt; whenever a weakening signal fires, `progress.status` is never reported as `reduced`, closing the gap where deleting or weakening a test could otherwise look like progress.

`reduced` is fail-closed. It is not enough for a prior implementation-category failure to simply stop failing (or for the current failure set to be a strict subset of the prior one): for every such resolved check, Rigor requires positive confirmation that its observed test coverage did not shrink — the prior and current `CheckFacts` for that `checkId` must both carry a parseable `testStats` count, and the current total must be greater than or equal to the prior total. When any resolved check lacks that confirmation (for example, because its runner's output could not be parsed into a test count), `compareFailures` reports `incomparable` instead of `reduced` and adds a `check <id>: cannot confirm test coverage did not shrink (no parseable test counts)` weakening signal. This closes the gap where an unparseable runner could let a hidden regression — failing tests deleted or weakened rather than fixed — be reported as genuine progress.

The weakening signals recorded here are the implemented subset of a broader test-weakening threat catalog; [test-integrity.md](test-integrity.md) classifies the remaining proposed, unimplemented signals and their planned shadow-mode collection.

All of this is deterministically derived by Rigor code from the verification's own check output — never copied from model input. It is kept entirely separate from the model-supplied, speculative `failureClass` on `attempt-result-input.v1`/`attempt.v1`, which remains free-form text for human review and is never treated as a fact.

## Bounded escalation decisions

The legacy `rigor.escalation-input.v1` and `rigor.escalation.v1` schemas remain accepted unchanged. They are narrative handoff artifacts and are not silently reinterpreted as selector inputs. Deterministic selection uses the explicit `rigor.escalation-decision-input.v1` schema instead. This is an additive migration: callers may continue using the legacy command, while new callers supply `--profiles`, `--contract`, every routing plan referenced by the history with repeated `--plan` arguments, and every linked attempt in sequence with repeated `--attempt` arguments. `--dry-run` returns the pure decision without writing; omitting it saves a new file under `.rigor/evidence/<task>/escalations/`, so decision evidence is append-only rather than replacing `escalation.json`.

Parsing and link validation fail closed before selection. The CLI checks task IDs, artifact IDs and hashes, routing-plan/profile linkage, the current attempt's binding to the named routing plan, agreement between the input budget and the plan-authorized budget, complete consecutive attempt sequences, elapsed time and relative-cost totals, current failure/progress/capability facts, and fingerprint repetition counts. Unsupported versions, malformed input, and stale or inconsistent linked artifacts exit `3`. Raw logs, provider transcripts, secrets, token counts, reasoning effort, provider cost, and unverified runtime identity are not fields in either decision schema.

The selector is pure: for the same parsed input, profiles, and availability report it returns the same decision. Its security-significant evaluation order is:

1. malformed, stale, or inconsistent input (parser/link validator);
2. scope violation, protected-test mutation, configured-check removal, or configured-check weakening (`stop-policy-violation`);
3. requirements/acceptance-criteria changes or another human-only choice (`stop-human-decision`);
4. maximum attempts, elapsed duration, or relative-cost exhaustion (`stop-budget-exhausted`);
5. infrastructure and timeout handling (`retry-infrastructure`, then `stop-infrastructure` once an identical failure fingerprint exceeds the retry limit; varying or absent fingerprints stay bounded by the budget stop above), with no model candidate selected;
6. failure-set progress and fingerprint repetition;
7. adjacent or direct target capability selection;
8. candidate eligibility (enabled, purpose-compatible, transmission-permitted, available/unknown rather than unavailable/incompatible, exact selected capability, and affordable);
9. deterministic tie-break by capability order, relative cost, then candidate ID;
10. a structured retry, escalation, or `stop-no-eligible-candidate` decision.

For an ordinary implementation defect, the next adjacent class is selected. A reduced failure set retries the current class; expanded and incomparable sets select the adjacent class. A contract contradiction, repeated unchanged fingerprint, safety/data-integrity concern, or architecture change can jump directly to premium or frontier when the policy, availability, and remaining budget permit it. Infrastructure and timeout failures never select premium/frontier merely because they are infrastructure failures.

The default `unchangedAttemptsBeforeDirect: 2` and `infrastructureRetries: 2` values are **initial hypotheses**, not empirically established quality guarantees. Both are configurable in the input's `thresholds`; omission uses those defaults. Human reviewers should revisit them using outcome evidence, especially for critical repositories, slow checks, or costly candidates. Maximum attempts, duration, and relative cost remain hard bounds regardless of apparent progress.

Example (paths abbreviated):

```sh
rigor escalate --dry-run \
  --input /tmp/escalation-decision-input.json \
  --profiles /tmp/model-profiles.json \
  --availability /tmp/availability.json \
  --contract .rigor/evidence/GH-14/contract.json \
  --plan .rigor/evidence/GH-14/routing/routing-plan_ID.json \
  --attempt .rigor/evidence/GH-14/attempts/attempt_1.json
```

Remove `--dry-run` to append the decision evidence. Rigor computes and records the decision only; it does not invoke a model or provider API.

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

## Outcome and retrospect metrics

`rigor outcome` records the human-reported disposition of a completed task and links it to the evidence that supports it:

```sh
rigor outcome \
  --input /tmp/outcome-input.json \
  --attempt .rigor/evidence/APP-123/attempts/attempt_ID.json \
  --verification .rigor/evidence/APP-123/verification.json \
  --review .rigor/evidence/APP-123/review.json
```

The command copies provider, model, capability class, and the linked attempt, verification, and review identifiers rather than trusting the input to repeat them. It fails closed on inconsistent claims: an `accepted` outcome requires a completed attempt and a linked passing verification; a `reverted` or escaped-defect outcome must be `accepted`; a `rejected` outcome cannot be accepted without model code changes; `retryCount` must match `attempt.sequence - 1` when an attempt is linked and is required otherwise. Token counts, provider cost, reasoning effort, and model identity are stored as measured-or-unavailable: when `usage.status` is not `recorded` the numeric fields must be absent and are persisted as `null`. Configured model identity is independent of metering and is always recorded with `attestation: "unverified"`; provider cost is a reported measurement, not a Rigor-verified charge, and `relativeCost` from routing remains an abstract weight, never a provider invoice or measured money.

`rigor retrospect` keeps its event counts and adds an aggregation read purely from each task's `outcome.json`. It never throws on a malformed outcome file; it counts those under `malformedOutcomes`. `outcomeTotals` reports accepted, rejected, reverted, escaped-defect, and data-completeness counts (usage status, model-identity presence, provider-cost presence, elapsed presence, attempt and verification linkage). `candidates` reports one entry per distinct candidate key (`model`, else `provider/capabilityClass` when attempt-linked, else `unlinked`), each with an explicit success-rate numerator and denominator, retries per outcome, average elapsed time over the outcomes that recorded it, human-intervention minutes, and its own data-completeness counts. Every rate exposes its denominator and every missing-data count is reported, so the metrics never hide unavailable measurements behind a bare total.
