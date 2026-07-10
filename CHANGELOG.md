# Changelog

## Unreleased

- Add `rigor governance`, a read-only GitHub configuration verifier covering branch rulesets and classic protection, the required `rigor` status check, approval count, stale-approval dismissal, code-owner review, last-push approval, force-push/deletion blocking, sampled CODEOWNERS coverage of policy-protected globs (early warning, not proof), and deployment environment protection. GET-only against a fixed host with redirect refusal, a 10-second timeout, and a response size limit; least-privilege token from the environment; fail-closed on unreadable configuration; the GitHub API is documented as an explicit trust boundary in the threat model ([#2](https://github.com/xhnagata/rigor/issues/2)).

## 0.1.0 - 2026-07-10

- Initial Claude Code plugin with risk preflight, contracts, deterministic verification, escalation, review preparation, retrospective aggregation, setup/upgrade, hook feedback, advisory review agent, and independent pull-request CI.
