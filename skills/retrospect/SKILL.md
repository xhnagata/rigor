---
description: Aggregate redacted local Rigor events to review friction and risk-tier trends. Use after tasks or during governance calibration.
disable-model-invocation: true
allowed-tools: Bash(rigor retrospect)
---

Run `rigor retrospect`. Alongside redacted event counts, it aggregates each task's `outcome.json` into `outcomeTotals` (accepted, rejected, reverted, escaped-defect, and data-completeness counts) and per-candidate `candidates` (success rate with explicit numerator and denominator, retries, elapsed time, human-intervention minutes, and per-candidate data-completeness). Every rate reports its denominator and every missing-data count, so do not read a bare total as if the data were complete. Reported cost is a measurement and the routing relative cost is an abstract weight, not a provider invoice. Use the counts as operational signals, not proof of safety. Recommend threshold changes only with reviewed evidence and note that policy changes are protected.
