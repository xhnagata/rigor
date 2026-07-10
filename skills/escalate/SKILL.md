---
description: Record a structured Rigor escalation when verification cannot be resolved without repetition or a stop condition is reached.
disable-model-invocation: true
argument-hint: <escalation-input-json>
allowed-tools: Bash(rigor escalate *), Read
---

Separate observed facts, attempted actions and results, disproved hypotheses, uncertain speculation, and the requested human decision. Run `rigor escalate --input "$ARGUMENTS"`. Never place raw secrets or unnecessary command output in the input.
