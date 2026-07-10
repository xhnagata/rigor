---
description: Install or safely update Rigor governance in the current Git repository. Use when the user asks to set up, configure, install, or upgrade Rigor.
disable-model-invocation: true
allowed-tools: Bash(rigor setup), Bash(rigor upgrade), Read
---

Run `rigor setup`. Report every created and unchanged file. If Rigor reports a conflict, do not overwrite it: show the existing-versus-generated difference and ask the maintainer to reconcile it. Then help the maintainer customize `.rigor/policy.json` and explain that GitHub branch protection and CODEOWNERS must be configured separately.
