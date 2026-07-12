# Test integrity: weakening threats and detection signals

- Status: design catalog, proposed for shadow-mode collection in
  [#22](https://github.com/xhnagata/rigor/issues/22) and calibrated
  enforcement in [#23](https://github.com/xhnagata/rigor/issues/23)
- Parent: [#3](https://github.com/xhnagata/rigor/issues/3) (semantic test
  weakening), designed in
  [#21](https://github.com/xhnagata/rigor/issues/21)
- Related: [#13](https://github.com/xhnagata/rigor/issues/13) (implemented
  failure fingerprints and progress),
  [#16](https://github.com/xhnagata/rigor/issues/16) (outcome-based
  calibration)

## Scope and status

This document catalogs how a test suite can be weakened so that `rigor verify`
passes without the acceptance criteria being met, and classifies which signals
of that weakening are deterministic facts, which are tool-derived
measurements, and which remain advisory interpretations.

Four signals are enforced today: the configured-check protection enforced by
policy and CI, and the three `weakeningSignals` mechanisms recorded by
[#13](https://github.com/xhnagata/rigor/issues/13) failure fingerprinting (a
check disappearing between attempts, a dropped observed test total, and the
fail-closed `incomparable` result when resolved checks lack parseable test
counts — see [orchestration.md](orchestration.md)).

Five more — TI-05, TI-06, TI-07, TI-08, and TI-09 — are now implemented as
**shadow-mode collection** in
[#22](https://github.com/xhnagata/rigor/issues/22): the `rigor
test-integrity-scan` command records them as `rigor.test-integrity-event.v1`
evidence, and `rigor test-integrity-classify` records human verdicts on them.
Shadow collection is record-only: a fired signal changes no verification,
progress, review, or merge outcome (`mode` is always `shadow`, `enforcement`
always `none`). Every other signal in this catalog remains proposed and
unimplemented. Enforcement is still explicitly deferred for the shadow signals
too — it will not be proposed until per-signal false-positive evidence has been
collected in shadow mode and calibrated against outcomes
([#16](https://github.com/xhnagata/rigor/issues/16)), a decision left to
[#23](https://github.com/xhnagata/rigor/issues/23). See
[Implemented shadow collection](#implemented-shadow-collection) below.

## Classification vocabulary

Every signal in this catalog carries exactly one of three labels. The label
classifies the claim the signal makes about test integrity when it fires, not
merely how its value was computed:

- **Deterministic fact** — the weakening-relevant claim itself is a total,
  reproducible function of Git objects or configured check output. "A check
  present in the prior attempt's verification is absent from this one" is a
  fact: the verification surface shrank, by definition, whatever the reason.
- **Tool-derived measurement** — the value requires a repository-specific
  tool (a coverage reporter, a mutation tester, a per-language parser). The
  measurement can be reproducible given a pinned tool and configuration, but
  the tool, its version, and its configuration are repository trust inputs
  that Rigor does not control or verify.
- **Advisory interpretation** — the claim ("a test was disabled", "this
  looser tolerance is unjustified") requires semantic judgment. Several
  advisory signals have a deterministically computable trigger — counting
  added `.skip(` tokens in a diff is a reproducible computation — but the
  count is not the claim. The fact is "N lines matching this token list were
  added in test-path files"; the interpretation "a test was disabled to hide
  a regression" is not derivable from the count. Where this middle ground
  applies, the catalog says explicitly which part is fact and which is
  interpretation, and the proposed shadow event records the two separately
  (`computation` vs `label`).

A signal that cannot be computed deterministically from Git objects or
configured check output is never labeled a deterministic fact.

### Enforcement levels

Signals occupy exactly one rung of this ladder, and may only move up it with
evidence:

1. **Rejected** — not collected at all; the reason is recorded below.
2. **Advisory only** — may be surfaced to a human or model reviewer as
   something to look at; never recorded as a weakening claim, never a gate.
3. **Shadow candidate (#22, implemented)** — recorded as a
   `rigor.test-integrity-event.v1` event by `rigor test-integrity-scan`
   without any effect on verification, progress, review, or merge, so
   false-positive rates can be measured against outcomes. TI-05, TI-06, TI-07,
   TI-08, and TI-09 are on this rung.
4. **Conditional shadow** — shadow collection only where the repository
   already runs the required tool as a configured check; never a Rigor
   default.
5. **Gate (implemented)** — deterministic enforcement that exists today.
   Only the configured-check protection and the #13 weakening signals are on
   this rung, and this catalog adds nothing to it.

## Scenarios

### Attacker scenarios

The attacker of interest is a delegated implementation model inside a Rigor
attempt whose incentive is to make `rigor verify` pass and cross-attempt
`progress` look like `reduced`. The same actions could equally be taken by a
careless human; intent is not observable and this catalog never claims to
detect it.

| ID  | Scenario                                                                                   | What fires today                                                                                                                                                    | What the catalog adds                                                                                                |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A1  | Delete the failing test cases so the suite passes                                          | TI-03 when both attempts have parseable counts (blocks `reduced`); TI-04 when they do not; nothing on a first attempt, which has no prior attempt to compare        | TI-06/TI-07 compare the contract base to the head, covering the first-attempt gap                                    |
| A2  | Mark the failing tests `skip`/`todo` so they stop running                                  | Often nothing: jest counts skipped tests inside `total`, so the observed total does not drop and TI-03 stays blind                                                  | TI-05 records the added markers as a shadow event                                                                    |
| A3  | Add `.only(` so only passing tests are selected                                            | TI-03 when the runner's reported total drops and counts parse                                                                                                       | TI-05 flags the marker even when counts do not parse                                                                 |
| A4  | Relax assertions or widen tolerances so failing tests pass                                 | Nothing: totals and checks are unchanged                                                                                                                            | TI-07 (net assertion-token decline) partially; TI-13/TI-15 remain advisory — the implemented mechanism is blind here |
| A5  | Regenerate snapshots wholesale to match broken output                                      | Nothing: the suite passes with unchanged totals                                                                                                                     | TI-08 records snapshot churn; interpretation stays advisory                                                          |
| A6  | Mock the dependency whose real behavior regressed                                          | Nothing: totals and checks are unchanged                                                                                                                            | TI-14 remains advisory; no deterministic signal exists                                                               |
| A7  | Weaken the configured check itself, or the script it invokes                               | TI-01: `.rigor/policy.json` is a protected critical-tier path and CI enforces `maxPolicyWeakening: "none"`; editing the `npm` script the check calls is not covered | TI-09 records changes to verification-adjacent files (scripts, runner/lint configs) as a shadow event                |
| A8  | Delete real tests and add the same number of tautological ones so the total stays constant | Nothing: TI-03 sees an unchanged total                                                                                                                              | TI-06/TI-07 may fire on the deletions; recognizing a tautology is semantic and stays with human review               |
| A9  | Weaken incrementally across attempts, or weaken and later restore counts                   | Each pairwise drop fires TI-03; a drop-then-refill of the total does not re-fire                                                                                    | Diff-based signals anchored to the contract base do not reset between attempts                                       |

### Accidental-change scenarios

Honest work produces the same observable traces, which is why most new
signals must start as shadow events rather than gates:

| ID  | Scenario                                                                | Expected signal behavior                                                                                                         |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| B1  | An honest refactor renames or moves test files without changing content | TI-06 must not fire: fixed-threshold rename pairing matches the files; TI-03 is unaffected because the total is unchanged        |
| B2  | Tests are deleted because the feature they covered was removed          | TI-03 and TI-06 fire; the change is legitimate and reviewable; the shadow record becomes false-positive evidence for calibration |
| B3  | A test-framework migration changes the runner's summary format          | Test counts stop parsing; #13 reports `incomparable` rather than `reduced` — fail-closed and honest, not a weakening verdict     |
| B4  | Snapshots are regenerated after an intentional UI change                | TI-08 fires benignly; this expected high false-positive rate is exactly why snapshot churn is shadow-only                        |
| B5  | A flaky test is quarantined with `.skip` and a tracking issue           | TI-05 fires benignly; the reviewer, not the signal, decides whether the quarantine is justified                                  |
| B6  | A parametrized test matrix is deliberately reduced to cut CI time       | TI-03 fires; the drop is real and worth a reviewer's attention even though the intent is benign                                  |

## Threat classes and signals

Signal identifiers are stable so shadow events and later calibration can
reference them.

### Assertion deletion and relaxation

Deleting `expect`/`assert` statements, or substituting weaker matchers
(`toEqual` → `toBeDefined`), leaves test counts unchanged while removing the
property being checked. Nothing implemented today observes this. A net
decline in assertion-like tokens across changed test-path files (TI-07) is
deterministically computable from the diff, but token counting cannot tell a
deleted assertion from one moved into a helper — the weakening claim is
advisory. Exact matcher-strength comparison (TI-15) requires a per-framework
substitution table and stays advisory; AST-level assertion counting (TI-10)
requires a per-language parser and is tool-derived.

### Tolerance widening

Loosening a numeric precision or delta (`toBeCloseTo(v, 5)` →
`toBeCloseTo(v, 1)`) makes a regression fit inside the tolerance. Which
argument direction is "wider" is matcher-specific knowledge, and whether a
widened tolerance is justified is a semantic question. TI-13 is advisory with
a deterministically computable trigger for an explicitly configured matcher
list.

### Skip, only, and todo markers

Disabling tests with `.skip(`/`.only(`/`it.todo`, `xit(`, `@pytest.mark.skip`,
`#[ignore]`, `t.Skip(` and similar markers silently deselects coverage.
Counting added marker tokens in changed test-path files (TI-05) is
deterministic to compute; the false-positive profile is framework-dependent
(comments, strings, identifiers that merely contain a token, legitimate
quarantines). Note that skipping frequently evades the implemented
total-count signal: jest reports skipped tests inside `total`, so TI-03 does
not fire for A2.

### Test-case removal

Deleting test cases or whole test files. The implemented #13 mechanism
already records two deterministic facts between attempts: a dropped observed
test total (TI-03) and a check that disappeared from the verification
(TI-02), and it fails closed as `incomparable` when resolved checks lack
parseable counts (TI-04). The proposed complement is diff-anchored: a
test-path file deleted without a fixed-threshold rename pair (TI-06) covers
the first attempt, which has no prior attempt to compare.

### Snapshot churn

Regenerating recorded snapshots to match broken output converts a failing
suite into a passing one without touching a single assertion. Changed paths
matching snapshot conventions (`__snapshots__/`, `*.snap`) alongside
implementation changes (TI-08) are deterministic to compute; intentional
snapshot updates after a UI change look identical, so the interpretation is
advisory and the expected false-positive rate is high.

### Mock substitution

Replacing a real dependency with a stub that returns the expected value hides
the regression behind the mock. Mocking is also normal, healthy test
practice, so an added-mock-token trigger (TI-14) carries almost no signal by
itself; the claim "this mock hides the regression" is irreducibly semantic.
Advisory only.

### Coverage decline

A coverage percentage drop needs a coverage tool, a baseline, and a scope
agreement, none of which Rigor provides or verifies — the measurement is
tool-derived (TI-11). One nuance: when a repository configures a
coverage-threshold command as a check in `.rigor/policy.json`, the check's
pass/fail outcome becomes configured check output and therefore deterministic
fact territory, while the percentage itself remains a tool-derived
measurement.

### Mutation-score decline

Mutation testing would directly measure whether assertions still kill
mutants, but it is expensive, timeout-prone, absent from most repositories,
and its score is not stable enough to compare across runs without dedicated
configuration. TI-12 is rejected for shadow collection; the only foreseen
path is a repository that explicitly configures a mutation check itself.

### Configured-check weakening

Editing the `checks` array in `.rigor/policy.json` is already covered:
policy is a protected critical-tier path, changes require human approval, and
CI enforces `ci.maxPolicyWeakening: "none"` (TI-01, implemented). A check
disappearing from a verification between attempts is likewise implemented
(TI-02). The uncovered indirection is weakening the target of an unchanged
check definition — for example editing the `package.json` `test` script that
a configured `npm test` check invokes, or a runner/lint/typecheck
configuration file. A change to such a verification-adjacent file (TI-09) is
deterministic to compute from the diff; whether the change weakens anything
is advisory.

## Signal classification

| Signal                                                                | Label                    | Confidence when fired                                       | Language/framework dependence                                          | False-positive risk                                        | Required context                                                                     | Enforcement level                   |
| --------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------- |
| TI-01 configured-check definition changed in `.rigor/policy.json`     | deterministic fact       | high — the verification surface itself changed              | none                                                                   | low; any policy edit is intentionally high-friction        | base policy loaded independently by CI                                               | gate (implemented)                  |
| TI-02 check disappeared from verification vs prior attempt (#13)      | deterministic fact       | high — the verification surface shrank                      | none                                                                   | low; check removal between attempts is rare and reviewable | prior finished attempt's `CheckFacts`                                                | gate (implemented)                  |
| TI-03 observed test total dropped vs prior attempt (#13)              | deterministic fact       | high that the total dropped; reason unknown                 | medium — requires a recognized summary format (`node:test`, jest-like) | medium; legitimate deletions (B2, B6) also drop totals     | prior finished attempt's `CheckFacts` with parseable `testStats`                     | gate (implemented)                  |
| TI-04 resolved check without parseable test counts (#13, fail-closed) | deterministic fact       | high that confirmation is absent; not evidence of weakening | medium — depends on runner output format                               | n/a — it withholds `reduced` rather than accusing          | prior and current `CheckFacts`                                                       | gate (implemented)                  |
| TI-05 skip/only/todo markers added in changed test-path files         | advisory interpretation  | medium; trigger is deterministic, meaning is not            | high — per-framework token list                                        | medium (B5 quarantines; tokens in strings/comments)        | configured test-path globs and token list                                            | shadow candidate (implemented, #22) |
| TI-06 test-path file deleted without a rename pair                    | advisory interpretation  | medium; deletion is a fact, weakening is not                | low — path-glob level                                                  | medium (B2 legitimate deletions)                           | configured test-path globs; fixed rename-detection threshold                         | shadow candidate (implemented, #22) |
| TI-07 net assertion-token decline across changed test-path files      | advisory interpretation  | low–medium; token counts approximate assertions             | high — per-language/framework token list                               | high (helper extraction, refactors)                        | configured test-path globs and assertion-token list                                  | shadow candidate (implemented, #22) |
| TI-08 snapshot files regenerated alongside implementation changes     | advisory interpretation  | low; churn is a fact, intent is not                         | medium — snapshot path conventions                                     | high (B4 intentional updates)                              | snapshot path conventions                                                            | shadow candidate (implemented, #22) |
| TI-09 verification-adjacent config or script changed                  | advisory interpretation  | medium; the change is a fact, weakening is not              | medium — per-ecosystem config file list                                | medium (routine dependency/config maintenance)             | configured list of verification-adjacent files; JSON parse of `package.json` scripts | shadow candidate (implemented, #22) |
| TI-10 AST-level assertion count decline                               | tool-derived measurement | medium given a correct parser                               | high — one parser per language                                         | medium (assertion helpers, macro-generated tests)          | per-language parser pinned by the repository                                         | advisory only (deferred)            |
| TI-11 coverage percentage decline                                     | tool-derived measurement | medium given a pinned tool and scope                        | high — tool- and configuration-specific                                | medium (moved lines, changed scope, tool nondeterminism)   | repository-configured coverage tool, baseline, and threshold                         | conditional shadow                  |
| TI-12 mutation-score decline                                          | tool-derived measurement | — (rejected)                                                | high                                                                   | high                                                       | mutation tool, pinned configuration, long runtime budget                             | rejected                            |
| TI-13 tolerance-matcher argument widened                              | advisory interpretation  | low–medium; direction is matcher-specific                   | high — per-matcher direction semantics                                 | medium (justified re-tuning)                               | configured matcher list with per-matcher direction table                             | advisory only                       |
| TI-14 mock/stub token added in changed test-path files                | advisory interpretation  | low; mocking is normal practice                             | high — per-framework mock idioms                                       | high                                                       | configured mock-token list                                                           | advisory only                       |
| TI-15 assertion matcher replaced by a weaker one                      | advisory interpretation  | low–medium; strength ordering is framework-specific         | high — per-framework substitution-pair table                           | medium (legitimate matcher changes)                        | configured matcher-strength pairs                                                    | advisory only                       |
| TI-16 LLM verdict on test quality as an authoritative check           | advisory interpretation  | — (rejected as a check)                                     | n/a                                                                    | unmeasurable a priori                                      | n/a                                                                                  | rejected as a check                 |

"Confidence when fired" is a design estimate to be replaced by measured
precision from shadow-mode collection; it is not a calibrated probability.

## Falsifiable tests

Each non-rejected signal has a concrete change that must fire it and a
concrete benign change that must not. Rejected signals state the rejection
reason instead.

| Signal | Must fire                                                                                                                                                                                                                             | Must not fire                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| TI-01  | A PR removes or edits the `git-diff-check` entry in the `.rigor/policy.json` `checks` array                                                                                                                                           | A PR that does not touch `.rigor/**`                                                                                |
| TI-02  | Prior attempt's verification ran checks `tests` and `lint`; the current verification contains only `lint`                                                                                                                             | Both attempts' verifications contain the same check set                                                             |
| TI-03  | Prior attempt's `tests` check reported `testStats.total` 120; the current attempt reports 100                                                                                                                                         | The current attempt reports 125 (or 120)                                                                            |
| TI-04  | A previously failing `tests` check resolves, but its current output yields no parseable summary line                                                                                                                                  | The resolved check has parseable prior and current counts of 120 and 120                                            |
| TI-05  | A diff adds a line `it.skip("charges the card", ...)` to an existing file matching the test-path globs                                                                                                                                | A diff adds `it("skips empty input", ...)` (no marker token) or edits `options.skip = true` in a non-test-path file |
| TI-06  | A diff deletes `test/payment.test.ts` with no rename pair at the fixed similarity threshold                                                                                                                                           | A diff renames `test/payment.test.ts` to `test/billing.test.ts` with identical content (paired by rename detection) |
| TI-07  | A diff removes four `expect(...)` lines from test-path files and adds none (net −4)                                                                                                                                                   | A diff moves four `expect(...)` lines from one test-path file to another (net 0)                                    |
| TI-08  | A diff regenerates thirty `*.snap` files alongside `src/**` changes (the event records counts, not a verdict)                                                                                                                         | A diff that changes no path matching the snapshot conventions                                                       |
| TI-09  | A diff changes the `package.json` `"test"` script from `node --test test/` to `node --test test/unit/`                                                                                                                                | A diff that only bumps the `package.json` `"version"` field                                                         |
| TI-10  | With the repository's pinned TypeScript parser, a diff reduces the assertion-call node count of a test file from 12 to 8                                                                                                              | A diff that reformats and renames variables without changing the assertion-call node count                          |
| TI-11  | The repository-configured coverage tool reports statement coverage 90.1% for the base and 84.0% for the head over the same scope                                                                                                      | Identical coverage output whose report lines are merely reordered                                                   |
| TI-12  | Rejected: mutation runs are expensive and timeout-prone, scores are unstable across runs without dedicated configuration, and no default tool exists; revisit only as an explicitly repository-configured check                       | —                                                                                                                   |
| TI-13  | A diff changes `toBeCloseTo(v, 5)` to `toBeCloseTo(v, 1)` in a test-path file (jest digits: lower is wider)                                                                                                                           | A diff that changes the expected value `v` while leaving the digits argument unchanged                              |
| TI-14  | A diff adds `jest.mock("../billing")` to a test file that previously imported the real module                                                                                                                                         | A diff that edits a test file already containing that mock without touching the mock lines                          |
| TI-15  | A diff replaces `expect(x).toEqual(y)` with `expect(x).toBeDefined()` (a configured weakening pair)                                                                                                                                   | A diff that replaces `toEqual` with `toStrictEqual` (a strengthening)                                               |
| TI-16  | Rejected as an authoritative check: a model verdict has no falsifiable specification, its false-positive profile cannot be stated in advance, and treating it as authoritative is an explicit non-goal; model review remains advisory | —                                                                                                                   |

## Shadow-mode event format (specification only)

Shadow collection in [#22](https://github.com/xhnagata/rigor/issues/22) would
record signals as append-only evidence without enforcing anything. This is a
specification of the JSON shape; no schema file, detector, or command is
created by this document. It follows the existing evidence conventions: no
raw command output or transcripts, repository-relative paths only, opaque
digests for content, bounded lengths, and explicit `null` rather than
fabricated values.

```json
{
  "schemaVersion": "rigor.test-integrity-event.v1",
  "artifactId": "test-integrity-event_<uuid>",
  "taskId": "APP-123",
  "createdAt": "2026-07-12T00:00:00.000Z",
  "mode": "shadow",
  "enforcement": "none",
  "attemptArtifactId": null,
  "verificationArtifactId": null,
  "diff": {
    "baseSha": "<40-hex commit sha>",
    "headSha": null,
    "worktreeDigest": "<opaque content hash>"
  },
  "signals": [
    {
      "signalId": "TI-05",
      "threatClass": "skip-only-todo",
      "label": "advisory-interpretation",
      "computation": "deterministic",
      "detector": { "name": "diff-token-scan", "version": "0.1.0" },
      "value": { "addedMarkers": 2, "removedMarkers": 0 },
      "paths": ["test/payment.test.ts"],
      "matchDigest": "<opaque hash of the normalized matched lines>",
      "note": null
    }
  ]
}
```

Field rules:

- `schemaVersion` is exactly `rigor.test-integrity-event.v1`.
- `mode` is exactly `shadow` and `enforcement` is exactly `none` in this
  version. A fired signal never changes verification, progress, review, or
  merge behavior; the fields exist so a later version cannot silently
  reinterpret v1 records as enforcement decisions.
- `attemptArtifactId` and `verificationArtifactId` link the event to existing
  evidence when the event was produced inside an attempt, and are explicitly
  `null` otherwise — never fabricated.
- `diff.baseSha` is the contract-base commit. `diff.headSha` is the head
  commit, or explicitly `null` when the event was computed over a dirty
  worktree, in which case `worktreeDigest` carries an opaque content hash;
  digests are never reversible to content.
- Each `signals` entry carries a `signalId` from this catalog, its
  `threatClass`, its single `label`
  (`deterministic-fact` / `tool-derived-measurement` /
  `advisory-interpretation`), and a `computation` of `deterministic`,
  `tool`, or `model`, keeping "how the value was computed" separate from
  "what the value claims".
- `detector` names the producing detector and version, or is `null` for a
  tool-derived value whose tool identity is unknown — unknown is recorded,
  not guessed.
- `value` contains only bounded numbers and enumerated strings — counts,
  deltas, percentages. No matched source text, test names, command output,
  or transcripts are ever embedded; `matchDigest` is an opaque hash over the
  normalized matched lines so two events can be compared without storing
  content.
- `paths` are repository-relative, at most 25 entries of at most 300
  characters each; when more paths matched, the count in `value` still
  reports the true number.
- `note` is an optional human- or orchestrator-supplied string of at most 200
  characters, or `null`; like other user-supplied summaries it is labeled
  input, never derived fact.
- At most 32 `signals` entries per event; an event records that truncation
  occurred rather than silently dropping the excess count.

## Interaction with the implemented #13 mechanism

The #13 mechanism (see
[orchestration.md](orchestration.md), "Failure fingerprints and progress",
and `src/fingerprint.ts`) is the only implemented, enforcing part of this
catalog: `rigor verify` derives normalized failure facts per check, and
`rigor attempt-finish` compares them against the most recent prior finished
attempt. Its `weakeningSignals` — a dropped observed test total, a check no
longer present, and the fail-closed requirement that `reduced` is only
reported when every resolved check has parseable, non-shrinking test counts —
are TI-02/TI-03/TI-04 in this catalog.

The proposed shadow signals are complementary, not a replacement:

- **They never alter `progress.status`.** A shadow event references the
  attempt and verification artifacts by ID; the #13 comparison remains the
  sole deterministic authority over `reduced`/`incomparable`.
- **They cover the axes #13 cannot.** The attempt comparison is pairwise and
  intra-task: a first attempt has no prior, jest counts skipped tests inside
  `total` (so A2 does not drop the total), and totals say nothing about
  assertion strength, tolerances, snapshots, or mocks (A4–A6, A8).
  Diff-anchored signals compare the contract base to the head and do not
  reset between attempts (A9).
- **They inherit its honesty rules.** Like `failureFacts`, shadow events
  persist only normalized facts and digests, never raw output, and record
  unknown values as `null`.

## Interaction with #16 outcome-based calibration

`rigor outcome` records the human-reported disposition of a task (accepted,
rejected, reverted, escaped defect) with linked attempt, verification, and
review identifiers. Joining shadow events to outcomes by task ID yields
per-signal false-positive evidence before any enforcement exists:

- a signal that fired on a task later accepted with no test-related review
  finding is false-positive evidence for that signal;
- a signal that fired on a task later reverted or carrying an escaped defect
  is (weaker) true-positive evidence;
- per-signal precision estimates, with explicit numerators and denominators
  in the style of `rigor retrospect`, are the precondition for
  [#23](https://github.com/xhnagata/rigor/issues/23) proposing any
  enforcement.

This document deliberately chooses no enforcement threshold, no minimum
sample size, and no promotion rule; those are calibration decisions that must
be made against collected evidence, not designed in advance of it.

## High-confidence shadow-mode candidates (#22)

Explicitly proposed for shadow collection, in descending expected value:

1. **TI-05** skip/only/todo markers added in changed test-path files — cheap,
   deterministic to compute, and covers the A2 evasion that the implemented
   total-count signal misses.
2. **TI-06** test-path file deleted without a rename pair — covers the
   first-attempt gap (A1) with a rename-safe benign case (B1).
3. **TI-09** verification-adjacent config or script changed — covers the A7
   indirection outside `.rigor/policy.json`.
4. **TI-07** net assertion-token decline — the only cheap signal aimed at A4;
   collected precisely because its false-positive rate is expected to be high
   and must be measured.
5. **TI-08** snapshot churn counts — high expected false positives (B4);
   shadow mode exists to quantify them.

Conditional: **TI-11** coverage decline, only where the repository already
runs a coverage tool as a configured check. Advisory only, not collected:
TI-10, TI-13, TI-14, TI-15. Rejected: TI-12 (mutation score as shadow
signal), TI-16 (LLM verdict as an authoritative check).

## Implemented shadow collection

[#22](https://github.com/xhnagata/rigor/issues/22) implements the five
high-confidence candidates as deterministic detectors over a unified Git diff
between a contract-base commit and the head (a committed sha or the dirty
worktree). Two commands manage the evidence, and neither reads or affects the
verification, attempt, review, or CI code paths:

- `rigor test-integrity-scan --task <id> --base <40hex> [--head <40hex>]
[--attempt <path>] [--verification <path>] [--note <string>]` runs the five
  detectors and writes an append-only `rigor.test-integrity-event.v1` under
  `.rigor/evidence/<task>/test-integrity/`. With `--head` omitted the base is
  compared to the dirty worktree, and the event records `diff.headSha: null`
  with an opaque `diff.worktreeDigest`. A dirty-worktree scan diffs tracked
  files only: an untracked file is invisible to every detector even though
  `worktreeDigest` covers it, so committed-head scans are the exact form and
  worktree scans are a preview. TI-09's scripts comparison parses the root
  `package.json` only; a nested package manifest counts as a changed file but
  its scripts are not compared. Linked `--attempt`/`--verification`
  artifacts must parse and share the task ID or the command exits `2`; when
  absent the linkage fields are explicit `null`.
- `rigor test-integrity-classify --event <path> --input <path>` records a
  human-reported `rigor.test-integrity-classification.v1` beside the event.
  Event linkage is copied from the event artifact, not trusted from the input;
  a verdict may only name a signal the event actually fired. `classifiedBy` is
  fixed to `human` — a **recorded declaration, not attested identity**, and it
  satisfies no control. The command refuses (exit `2`) while the event's task
  has an unfinished attempt session, so a delegated model cannot confirm its
  own observation mid-attempt. This guard reads unsigned local evidence: an
  actor that can write the evidence directory could fabricate a finalized
  attempt artifact and bypass it, which is one more reason a classification
  is a declaration for calibration, never an authorization.

`rigor retrospect` gains a `testIntegrity` section aggregating events, malformed
event/classification counts, and per-signal `{ evaluated, fired, unreviewed,
humanClassified: { truePositive, falsePositive, uncertain } }` with explicit
denominators; `evaluated` is the number of scans that considered the signal
(the false-positive denominator), and `unreviewed` counts fired signals with no
human verdict.

Detectors are `diff-token-scan`/`diff-name-status`/`diff-path-scan`/
`config-diff-scan`, all version `0.1.0`, and every signal entry carries
`label: "advisory-interpretation"` and `computation: "deterministic"`: the
counts are the facts, the weakening claim is not. Built-in defaults (no policy
or config surface):

- **Test-path globs:** `test/**`, `tests/**`, `spec/**`, `**/__tests__/**`,
  `**/*.test.*`, `**/*.spec.*`, `**/*_test.go`, `**/*_test.py`,
  `**/test_*.py`.
- **TI-05 marker tokens:** `.skip(`, `.only(`, `.todo(`, `it.todo`,
  `describe.todo`, `xit(`, `xdescribe(`, `fit(`, `fdescribe(`,
  `@pytest.mark.skip`, `@unittest.skip`, `#[ignore]`, `t.Skip(`,
  `t.SkipNow(` — each shaped so a plain identifier or prose containing the word
  does not match.
- **TI-06 rename detection:** Git's fixed 50% similarity threshold (`-M50%`);
  a deletion is only reported when no rename pair is found at that threshold.
- **TI-07 assertion tokens:** `expect(`, `assert`, `should`, `toBe`,
  `toEqual`, `toStrictEqual`, `toMatch`, `toContain`, `toThrow`,
  `toHaveBeen*`, `ok(`, `notOk(`, and `require.<member>`; the signal fires only
  on a net decline across all changed test-path files.
- **TI-08 snapshot conventions:** `**/__snapshots__/**`, `**/*.snap`, fired
  only alongside a non-test, non-snapshot implementation change.
- **TI-09 verification-adjacent files:** `tsconfig*.json`, ESLint/Prettier/
  Vitest/Jest/Mocha/Babel config files, `Makefile`, `.github/workflows/**`,
  plus a change to the `package.json` `scripts` object detected by parsing the
  base and head `scripts` (a version-only bump does not fire).

Marker and assertion counting operates only on the added/removed lines of the
diff in test-path files. Each fired signal stores bounded value counts, at most
25 repository-relative paths (the true count stays in `value`), and a
`matchDigest` — a sha256 over the normalized matched lines using the same
noise-masking style as `src/fingerprint.ts` — so no raw matched content or
secret ever persists. An event carries at most 32 signals and records
`signalsTruncated` rather than silently dropping any; a scan that fires nothing
still writes an event with an empty `signals` array and the full
`signalsEvaluated` list, which is the denominator for false-positive
measurement.

## What must never be advertised

None of the following may ever be claimed on the basis of this catalog, its
shadow events, or the implemented #13 mechanism:

- **"The tests are sufficient"** or **"the assertions are meaningful."**
  Counts, totals, tokens, coverage, and even mutation scores measure
  presence, not meaning; semantic test quality remains human review.
- **"A passing suite proves the acceptance criteria."** Verification proves
  that configured commands exited successfully on specific content, nothing
  more.
- **"No signal fired, therefore nothing was weakened."** Evasion A8 —
  replacing real tests with tautologies at constant totals — defeats every
  deterministic signal in this catalog by construction.
- **"A fired signal proves dishonesty."** Every attacker scenario has an
  accidental twin (B1–B6); signals select changes for attention, they do not
  convict.
- **"Shadow collection is enforcement."** A `rigor.test-integrity-event.v1`
  record changes no verification, progress, review, or merge outcome.
- **"An advisory or model review verdict is an authoritative check."** This
  remains an explicit non-goal.

The threat-model row "New regressions hidden by deleting or weakening tests"
and the [MVP limitations](mvp-limitations.md) entry for
[#3](https://github.com/xhnagata/rigor/issues/3) remain accurate: the MVP
reliably flags deleted tests and mutation or removal of configured checks;
everything beyond that in this catalog is proposed, unimplemented, and —
even once implemented — bounded to the non-semantic claims stated above.
