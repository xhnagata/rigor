---
description: Prepare a minimal Rigor review bundle after deterministic verification. Use immediately before requesting review.
disable-model-invocation: true
argument-hint: <contract> <preflight> <verification>
allowed-tools: Bash(rigor review *), Read
---

Re-run preflight if Git state or planned scope changed. Invoke `rigor review` with the linked contract, latest preflight, and passing verification. If external transmission is denied, do not send the bundle or repository content externally. State that CI will independently derive base/head facts.
