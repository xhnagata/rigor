---
description: Record one bounded Claude or Codex implementation attempt against a saved Rigor routing plan and contract. Use immediately before and after delegated implementation.
argument-hint: <routing-plan-json> <contract-json>
allowed-tools: Read, Write, Bash(rigor attempt-start *), Bash(rigor verify *), Bash(rigor attempt-finish *), Bash(rigor test-integrity-scan *)
---

Run `rigor attempt-start --plan <routing-plan-json> --contract <contract-json>` immediately before delegation. Stop if policy, HEAD, contract scope, unfinished-attempt, or attempt-budget checks fail. The selected provider/model are configured claims with `executionIdentityStatus: "unverified"`; never present them as attested runtime identity.

After delegation, first run `rigor verify --dry-run --contract <contract-json>`. If it fails, finalize the attempt as `failed` without saving the write-once verification artifact. If it passes and this is the accepted final attempt, run normal `rigor verify --contract <contract-json>` once to persist verification. Write a minimal `rigor.attempt-result-input.v1` outside the repository. Use `status: "completed"` only with that passing saved verification and pass it through `--verification`; otherwise use `failed` or `cancelled` and include a short failure class when known. Always run `rigor attempt-finish`, including after agent failure, so an unfinished session does not block the next bounded attempt.

Stop on `scope-violation` or `budget-exceeded`. Do not retry an unchanged failure. Do not infer token usage, price, model identity, or reasoning effort from a configured model name.

Optionally, after the verification is saved, run `rigor test-integrity-scan --task <id> --base <contract-base-sha> --head <head-sha> --attempt <attempt.json> --verification <verification.json>` to record advisory test-weakening signals as shadow evidence. It is record-only and never changes the attempt result, verification, `progress`, review, or merge; a fired signal is a prompt for human review, not proof of weakening, and an empty result is not proof of its absence.
