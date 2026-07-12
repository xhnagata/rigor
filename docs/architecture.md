# Architecture

## Responsibilities

| Component              | Responsibility                                                                                                                                 | Authority                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Plugin manifest        | Discovery and versioned packaging                                                                                                              | None                                                  |
| Skills                 | Tell Claude when and how to invoke deterministic workflow steps                                                                                | Advisory                                              |
| Reviewer agent         | Read-only synthesis of already prepared review material                                                                                        | Advisory                                              |
| Hook                   | Fast preflight reminder/check on prompt submission; no-op when Rigor is absent                                                                 | Bypassable early feedback                             |
| TypeScript library/CLI | Parse schemas, normalize paths, evaluate policy, preview constrained routing, inspect Git, run configured checks, and write redacted artifacts | Deterministic local result                            |
| Generated policy       | Repository-specific classification, risk, scope, and verification rules                                                                        | Reviewed input                                        |
| Generated CI           | Check base/head, policy evolution, protected changes, evidence linkage, and run deterministic checks                                           | Authoritative required check when protected by GitHub |
| GitHub/human review    | Protect branch, require CI/CODEOWNERS/independent approval                                                                                     | Authoritative merge control                           |

## Data flow

The CLI reads `.rigor/policy.json`, an intent JSON file, and Git facts. Pure policy evaluation produces a preflight artifact. Contract creation consumes that artifact and explicit acceptance criteria. Verification rechecks scope and executes configured commands directly (no shell), storing only status, duration, a digest, and normalized per-check failure facts (a category, error class, normalized failed-test names, and opaque digests) with a verification-wide failure fingerprint; raw command output is never persisted. Escalation and review consume the linked artifacts. Retrospective reads redacted JSONL events.

Optional routing preview consumes a preflight artifact, an explicit assessment, and model profiles. A pure selector excludes candidates by enabled state, purpose, additional-transmission policy, capability, and relative-cost budget. Recorded plans bind the selection to the preflight, contract, policy, profiles, and HEAD. Claude or Codex implementation attempts are append-only, budgeted, scope-checked, and require linked passing verification to finish as completed. Each finished attempt also copies its verification's failure fingerprint and compares it deterministically against the most recently finished prior attempt, recording whether the implementation-category failure loop is unchanged, reduced, expanded, or incomparable. Optional `codex-plugin-cc` consultation is bracketed by snapshots that detect content, path, or HEAD mutation. The [orchestration design](orchestration.md) defines these boundaries.

In CI, `rigor ci` receives GitHub-provided base/head SHAs, verifies that both are commits, reads policy and evidence directly from each Git object, computes `git diff`, rejects policy weakening or unmatched evidence, and runs the head policy's checks. The verifier does not accept contributor-provided changed-path or pass claims as facts.

## Main decisions

- The plugin uses Claude Code's documented default directories: `.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/hooks.json`, and `bin/`.
- Runtime code is bundled to one CommonJS file so installed plugins need Node.js but do not need `npm install`. The `bin/rigor` launcher resolves through `CLAUDE_PLUGIN_ROOT`/its own path.
- Policy and artifacts are JSON with an explicit `schemaVersion`. Runtime validation is dependency-free and fail-closed.
- Globs are deliberately limited to segment-aware `*`, `?`, and `**`. Paths are normalized before matching. This keeps matching reviewable and consistent in local and CI execution.
- Setup writes only absent, Rigor-owned files. Existing unequal content is reported as a conflict; upgrades never silently replace user changes.
- Hook input is treated as untrusted JSON. Unconfigured repositories exit successfully; configured repositories with missing or invalid policy return a blocking `UserPromptSubmit` decision.
- External transmission is a policy result, not an action by the deterministic CLI. The CLI never calls a model; `rigor governance` is its single remote command and sends read-only GET requests to the GitHub API. When explicitly invoked, the orchestration/consult Skills may delegate minimal context to Claude Code agents or an installed `codex-plugin-cc` only after policy permits it. The [threat model](threat-model.md) documents these trust boundaries.

## Official specification basis

The structure and protocols were checked against the current Claude Code documentation for [plugins](https://code.claude.com/docs/en/plugins-reference), [skills](https://code.claude.com/docs/en/skills), [hooks](https://code.claude.com/docs/en/hooks), [subagents](https://code.claude.com/docs/en/sub-agents), and [settings](https://code.claude.com/docs/en/settings) on 2026-07-10. Plugin CI uses the documented `claude plugin validate --strict` command when Claude Code is available.
