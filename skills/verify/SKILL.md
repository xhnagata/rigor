---
description: Deterministically verify a Rigor task contract and record redacted evidence. Use after implementation and before review.
disable-model-invocation: true
argument-hint: <contract-json>
allowed-tools: Bash(rigor verify *), Read
---

Run `rigor verify --contract "$ARGUMENTS"`. The CLI, not the model, decides command outcomes and scope violations. Do not paraphrase a failing result as success. If repeated attempts do not resolve it, use the escalation skill with a new hypothesis instead of repeating the same action.
