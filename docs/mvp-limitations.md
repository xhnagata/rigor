# MVP limitations and follow-up

Rigor 0.1.0 intentionally leaves these controls to follow-up work:

- Append-only implementation-attempt persistence, autonomous Codex implementation, provider availability probing, and empirical routing calibration. `rigor route --dry-run` previews a deterministic selection from explicit assessments and configured relative-cost profiles. Claude orchestration and `codex-plugin-cc` consultation occur only through explicitly invoked Skills; the CLI itself does not invoke a model or observe actual provider usage.

- [Windows-native launcher and path/case testing](https://github.com/xhnagata/rigor/issues/1). The runtime logic is portable, but plugin execution is currently a POSIX shell script.
- [Cryptographic artifact signing, binary attestation, and SLSA provenance](https://github.com/xhnagata/rigor/issues/4). CI independently re-derives Git facts but does not attest who produced local evidence.
- [Semantic detection of subtly weakened or low-quality tests](https://github.com/xhnagata/rigor/issues/3). MVP reliably flags deleted tests and any mutation/removal of configured checks; semantic quality remains human review.
- [GitHub API verification of branch protection, rulesets, CODEOWNERS approval independence, and deployment environments](https://github.com/xhnagata/rigor/issues/2) is now available read-only via `rigor governance`. Remaining limits: classic branch protection is only readable with administration read scope (reported as unverifiable otherwise), CODEOWNERS matching is a documented last-match-wins subset whose coverage check samples one representative path per protected glob (an early warning, not proof of full glob coverage), and Rigor still makes no configuration writes.
- A managed remote metrics service. `retrospect` is local and redacted by design; teams must export only under an approved data policy.

None of these gaps is presented as an implemented guarantee.
