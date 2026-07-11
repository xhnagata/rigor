---
description: Consult Codex through codex-plugin-cc with Rigor policy and deterministic pre/post worktree checks. Use for a bounded second opinion, design discussion, adversarial challenge, or rescue when preflight permits additional external transmission.
argument-hint: <preflight-json> <consultation-request-json>
allowed-tools: Read, Grep, Glob, Write, Agent, Bash(rigor consult-start *), Bash(rigor consult-finish *)
---

Run `rigor consult-start --preflight <preflight-json> --input <consultation-request-json>` before invoking Codex. Stop if it exits nonzero. Send only the requested decision, the minimum relevant repository-relative diff and files, the contract constraints, and necessary verification facts to `codex:codex-rescue`. Do not send the whole Claude transcript. For review or adversarial-review mode, keep the task read-only; prompt constraints are advisory, so the deterministic finish check remains mandatory.

Ask Codex to separate facts, options, recommendation, uncertainty, and human decisions. Do not request hidden reasoning or chain of thought. Invoke it synchronously unless the user explicitly requests background execution and the job can still be finalized in this session.

After the result, write a minimal `rigor.consultation-result-input.v1` JSON file outside the repository. Record unavailable model, effort, job, or usage metadata as absent or `usageStatus: "unavailable"`; never infer it. Run `rigor consult-finish --session <saved-session-path> --input <result-json>`. If it reports `mutated-worktree`, stop and show the unexpected path/state change. Never treat Codex agreement as verification or approval.
