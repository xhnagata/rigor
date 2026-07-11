---
description: Orchestrate a Rigor-controlled Claude Code task using deterministic routing, bounded model delegation, verification, and optional codex-plugin-cc consultation. Use when the user explicitly requests autonomous model selection and execution.
argument-hint: <intent-json> <contract-input-json> <routing-input-json> <model-profiles-json>
allowed-tools: Read, Grep, Glob, Write, Agent, Bash(rigor preflight *), Bash(rigor contract *), Bash(rigor route *), Bash(rigor verify *), Bash(rigor escalate *), Bash(rigor review *), Bash(rigor consult-start *), Bash(rigor consult-finish *)
---

Run preflight before any edit, then create the contract and run `rigor route --dry-run` with the explicit assessment and profiles. Explain that assessment fields are judgments. Stop on an unroutable decision, denied transmission for an additional provider, a stop condition, or missing required human decision.

For a selected Claude candidate, require a concrete configured model before autonomous delegation. Invoke one implementation agent with that model and give it only the contract, allowed paths, acceptance criteria, constraints, relevant files, verification commands, and stop conditions. If the Claude Code runtime cannot honor the configured model, stop instead of silently substituting another model. The implementation agent must not approve its own result.

Phase 2 does not autonomously delegate implementation to Codex. A Codex selection for consultation, review, adversarial-review, or rescue must use the Rigor consultation start/finish protocol and `codex-plugin-cc`; follow the `/rigor:consult` procedure. A Codex implementation selection is advisory only and requires a later phase with attempt persistence.

After implementation, run deterministic verification. Do not repeat an unchanged failed attempt. On a stop condition or unresolved failure, create a structured escalation separating facts, attempts, disproved hypotheses, speculation, and the requested decision. On success, prepare the linked review bundle. Model output, routing choice, and cross-model agreement never satisfy CI or human approval.
