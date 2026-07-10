---
description: Create and follow a versioned Rigor task contract from preflight evidence. Use after Rigor preflight and before editing.
disable-model-invocation: true
argument-hint: <preflight-json> <contract-input-json>
allowed-tools: Bash(rigor contract *), Read
---

Ensure the contract input has observable acceptance criteria, minimum allowed path globs, constraints, and the same task ID as preflight. Run `rigor contract --preflight <file> --input <file>`. During work, stop when scope or a stop condition is reached; do not silently broaden the contract.
