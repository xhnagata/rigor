# MVP limitations and follow-up

Rigor 0.1.0 intentionally leaves these controls to follow-up work:

- [Windows-native launcher and path/case testing](https://github.com/xhnagata/rigor/issues/1). The runtime logic is portable, but plugin execution is currently a POSIX shell script.
- [Cryptographic artifact signing, binary attestation, and SLSA provenance](https://github.com/xhnagata/rigor/issues/4). CI independently re-derives Git facts but does not attest who produced local evidence.
- [Semantic detection of subtly weakened or low-quality tests](https://github.com/xhnagata/rigor/issues/3). MVP reliably flags deleted tests and any mutation/removal of configured checks; semantic quality remains human review.
- [GitHub API verification of branch protection, rulesets, CODEOWNERS approval independence, and deployment environments](https://github.com/xhnagata/rigor/issues/2). README documents the required settings, but the plugin has no credentials and makes no external writes.
- A managed remote metrics service. `retrospect` is local and redacted by design; teams must export only under an approved data policy.

None of these gaps is presented as an implemented guarantee.
