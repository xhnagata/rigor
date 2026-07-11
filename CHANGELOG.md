# Changelog

## 0.2.0 - 2026-07-11

- Fix the generated `.rigor/rigor-ci.cjs` entrypoint so direct GitHub workflow execution runs the verifier instead of exiting successfully without output. E2E now executes the generated bundle by its installed filename and requires parseable verifier output.
- Add recorded routing plans and `attempt-start`/`attempt-finish` around Claude or `codex-plugin-cc` implementation. Attempts enforce one active session, maximum attempts, duration and contract scope, mark configured execution identity unverified, and require linked passing verification before recording `completed`; `verify --dry-run` allows failed retries without consuming write-once verification evidence.
- Add policy-gated `consult-start`/`consult-finish` commands, append-only Codex consultation session/result artifacts, content-sensitive worktree hashing, and `/rigor:consult` plus `/rigor:orchestrate` Skills. Consultation finalization fails when content, changed paths, or HEAD differ, even when Git status still names the same modified path.
- Add advisory `rigor route --dry-run` with versioned routing-input, model-profile, routing-decision, attempt, and consultation schemas. The pure selector separates explicit complexity assessments from deterministic preflight controls, excludes candidates by purpose, capability, additional external transmission, and relative-cost budget, and invokes no model. Document the planned optional `codex-plugin-cc` boundary and its pre/post Git mutation checks.
- Add `rigor governance`, a read-only GitHub configuration verifier covering branch rulesets and classic protection, the required `rigor` status check, approval count, stale-approval dismissal, code-owner review, last-push approval, force-push/deletion blocking, sampled CODEOWNERS coverage of policy-protected globs (early warning, not proof), and deployment environment protection. GET-only against a fixed host with redirect refusal, a 10-second timeout, a response size limit, and a pagination guard that treats unfetched `rel="next"` pages as unverifiable; least-privilege token from the environment; fail-closed on unreadable configuration; the GitHub API is documented as an explicit trust boundary in the threat model ([#2](https://github.com/xhnagata/rigor/issues/2)).

## 0.1.0 - 2026-07-10

- Initial Claude Code plugin with risk preflight, contracts, deterministic verification, escalation, review preparation, retrospective aggregation, setup/upgrade, hook feedback, advisory review agent, and independent pull-request CI.
