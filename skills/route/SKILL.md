---
description: Preview a deterministic, policy-constrained model routing decision without invoking a model. Use after Rigor preflight when evaluating an implementation, consultation, review, adversarial review, or rescue candidate.
disable-model-invocation: true
argument-hint: <preflight> <routing-input> <model-profiles>
allowed-tools: Bash(rigor route *), Bash(rigor availability *), Read
---

Run `rigor route --dry-run` with the linked preflight, explicit routing input, and model profiles. Treat complexity, ambiguity, novelty, and verification strength as assessments rather than deterministic facts. Explain excluded candidates and their reason codes. Never claim that dry-run invoked a model, measured actual cost, or authorized external transmission.

To take observed candidate invocability into account, first run `rigor availability --profiles <model-profiles>`, save the report, and pass it with `--availability`. It excludes `unavailable` and `incompatible` candidates before selection; `unknown` never excludes a candidate. Availability is an observation, not attestation: it does not prove which runtime model runs, and configured identity, reasoning effort, usage, and cost stay unverified/unknown. Never present a filtered-then-reselected candidate as a silent substitution — the excluded reason codes make it explicit.
