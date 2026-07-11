# MVP limitations and follow-up

Rigor 0.1.0 intentionally leaves these controls to follow-up work:

- Cryptographic runtime/model attestation, concurrent attempt coordination, authoritative remote usage/cost collection, and empirical routing calibration. Claude and `codex-plugin-cc` execution occurs only through explicitly invoked Skills; the CLI records configured identity as unverified and does not invoke a model or observe actual provider usage. `rigor availability` now probes candidate invocability through documented, bounded local interfaces and marks each candidate available/unavailable/unknown/incompatible, but this is an observation, not attestation: it does not prove which runtime model served a request, and runtime identity, reasoning effort, usage, and cost remain unverified/unknown.

- [Windows-native launcher and path/case testing](https://github.com/xhnagata/rigor/issues/1). The runtime logic is portable, but plugin execution is currently a POSIX shell script.
- [Cryptographic artifact signing, binary attestation, and SLSA provenance](https://github.com/xhnagata/rigor/issues/4). CI independently re-derives Git facts but does not attest who produced local evidence.
- [Semantic detection of subtly weakened or low-quality tests](https://github.com/xhnagata/rigor/issues/3). MVP reliably flags deleted tests and any mutation/removal of configured checks; semantic quality remains human review.
- [GitHub API verification of branch protection, rulesets, CODEOWNERS approval independence, and deployment environments](https://github.com/xhnagata/rigor/issues/2) is now available read-only via `rigor governance`. Remaining limits: classic branch protection is only readable with administration read scope (reported as unverifiable otherwise), CODEOWNERS matching is a documented last-match-wins subset whose coverage check samples one representative path per protected glob (an early warning, not proof of full glob coverage), and Rigor still makes no configuration writes.
- A managed remote metrics service. `retrospect` is local and redacted by design; teams must export only under an approved data policy.

None of these gaps is presented as an implemented guarantee.
