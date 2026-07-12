# Provenance and consumer verification

This document covers **producer provenance** as implemented in
[#25](https://github.com/xhnagata/rigor/issues/25) under
[ADR 0001](adr/0001-provenance-trust-model.md): keyless GitHub OIDC Artifact
Attestations carrying SLSA v1 build provenance over three release subjects, plus
a fail-closed reference verifier and its operational policy.

## What #25 does and does not provide

- It **does** produce, on a maintainer-authorized `v*.*.*` tag push, GitHub
  Artifact Attestations over the release bundle `dist/rigor.cjs`, a
  deterministic complete-plugin archive, and a detached release manifest, and it
  ships a fail-closed reference verifier ([`scripts/verify-provenance.mjs`](../scripts/verify-provenance.mjs))
  that checks the exact downloaded bytes against independently held policy.
- It **does not** claim any SLSA Build Level. #25 may show the format is
  SLSA-compatible; a level claim needs a separate assessment of the build
  platform and provenance path.
- It **does not** unblock [#26](https://github.com/xhnagata/rigor/issues/26).
  The ordinary Claude Code marketplace install/update flow still has **no
  confirmed pre-activation verification point** that checks the exact cached
  bytes before hooks, skills, agents, or `bin/rigor` execute, so there is no
  end-to-end distribution guarantee for a normal marketplace install.
- It **does not** verify runtime model identity. Configured Claude/Codex model
  names remain `unverified`.
- A manifest, checksum, tag, release page, or CI badge placed beside an artifact
  is **not** independent proof. Trust derives only from verifying the
  attestation against policy the consumer holds independently of the release.

## The three attested subjects

1. `dist/rigor.cjs` — the executed bundle. Attesting only this would leave
   hooks, skills, agents, launcher, and manifests substitutable.
2. `rigor-<version>.tar.gz` — a deterministic archive of the complete plugin
   file set (built by [`scripts/package-plugin.mjs`](../scripts/package-plugin.mjs),
   a pure-Node ustar writer with a normalized gzip header). Byte reproducibility
   holds within a pinned toolchain (CI Node 22, esbuild 0.25.6); the manifest
   records the exact tool versions used.
3. `rigor-<version>.release-manifest.json` — a detached manifest recording the
   tag, source commit, workflow ref/digest, and the SHA-256 of both the bundle
   and the archive. It is validated against
   [`schemas/release-manifest.v1.schema.json`](../schemas/release-manifest.v1.schema.json).
   A manifest packaged **inside** the archive could not record the digest of the
   archive that contains it, so the archive digest lives only in this detached
   manifest and no subject is self-referential.

## Verifying a downloaded subject

Run the GitHub CLI verification with signer, source, issuer, runner, and
predicate restrictions, then apply the certificate-extension checks the flags do
not enforce:

```sh
gh attestation verify <subject> \
  --repo xhnagata/rigor \
  --signer-workflow xhnagata/rigor/.github/workflows/release.yml \
  --signer-digest <workflow-commit-sha> \
  --source-digest <release-commit-sha> \
  --source-ref refs/tags/vX.Y.Z \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --deny-self-hosted-runners \
  --predicate-type https://slsa.dev/provenance/v1 \
  --format json
```

The `--repo`, `--signer-workflow`, `--signer-digest`, `--source-digest`,
`--source-ref`, and `--deny-self-hosted-runners` flags do **not** enforce the
numeric repository id, the build trigger event, or the tag pattern. From the
returned certificate JSON, additionally require:

- numeric repository id (Fulcio extension OID `1.3.6.1.4.1.57264.1.14`) ==
  `1296432215`, so a renamed or recreated repository cannot satisfy the name
  expectation alone;
- build trigger event == `push`;
- source ref matches `^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$`;
- runner environment == `github-hosted`.

The reference verifier performs the `gh` call and all of these checks and fails
closed on a nonzero `gh` exit, empty output, an unknown JSON shape,
ambiguous/multiple conflicting results, a denied digest, missing freshness, or
any mismatch — and never prints `verified` on failure:

```sh
node scripts/verify-provenance.mjs <subject> \
  --tag vX.Y.Z \
  --source-digest <release-commit-sha> \
  --signer-digest <workflow-commit-sha> \
  --denylist consumer-denylist.json \
  --policy consumer-policy.json
```

`--source-digest` (the release commit equal to the tag target) is **required**:
ADR 0001 binds the exact source commit, so the verifier exits non-zero and
refuses to verify if no expected source commit is supplied via `--source-digest`
or a policy `expectedSourceDigest`. The verifier also binds the exact
`refs/tags/vX.Y.Z` ref (not merely the SemVer pattern) from `--tag`, so a
certificate relabeled to a different valid tag is rejected by the verifier
itself. `--signer-digest` is strongly recommended; omitting it prints a
prominent warning because any signer-workflow revision would otherwise be
accepted.

For the archive subject, pass `--manifest rigor-<version>.release-manifest.json`
to also reject a valid archive presented with a mismatched detached manifest
(mix-and-match substitution): the verifier recomputes the archive SHA-256 and
compares it to `subjects.pluginArchive.sha256`.

## Consumer-held policy (not shipped with the release)

The consumer holds the following independently of the Rigor release; a release
cannot alter or exempt itself from any of it:

- **gh version pinning.** Pin and record the `gh` CLI version used for
  verification. Verifier behavior and JSON shape can change across versions.
- **Trusted-root refresh ≤ 7 days.** Refresh the Sigstore trusted root at least
  weekly. A stale root cannot reveal a later revocation.
- **Offline maximum age ≤ 30 days.** For offline verification, accept a
  pre-fetched attestation bundle and trusted root only within a 30-day window;
  otherwise do not install or update.
- **Compromised-digest denylist.** The denylist is distributed and maintained by
  the consumer (`--denylist`), never sourced from the Rigor release. Deny
  compromised subject digests, source commits, and workflow digests.

## Root rotation

Sigstore roots rotate through TUF. Refresh the trusted-root snapshot on the
schedule above. Offline verification against a snapshot only proves what was
known when the snapshot was taken; it cannot reflect a later rotation or
revocation, so keep the snapshot within the freshness window and re-verify
online when possible.

## Attestation deletion, withdrawal, and revocation

Attestations can be deleted, and **deletion is not retroactive revocation** of
already downloaded bytes. To withdraw a release: stop distributing it, add its
tag, source commit, and subject digests to the consumer denylist, and require an
explicit human approval for any replacement version. Consumers must not treat
the absence of an attestation, or a still-valid historical attestation, as proof
of current approval.

## Replay and freshness

A valid old attestation and its subject can be replayed; provenance creation
time is not release approval. Consumers hold an independent approved-version and
maximum-staleness policy: signature validity alone does not mean current
approval. Pin the exact source commit and subject digests rather than the tag
name.

## Release rollback

To roll back, re-point consumers at a previously approved, still-trusted version
by its pinned commit and subject digests (not by tag name), and deny the
withdrawn version's tag/commit/digests. Because the producer grants no
`contents: write` in the signer workflow, publishing or removing release assets
is a separate human-authorized action; rollback of distributed bytes is a
consumer-policy change, not a producer capability.

## Immutable releases (documented option, not enabled)

GitHub immutable releases are a complementary control that locks a published tag
and its assets once enabled. Enabling them is a separately authorized
repository-settings decision reserved to maintainers, and **#25 does not enable
them.** Until they are enabled and used, consumer policy must treat every tag as
mutable and pin the exact source commit and subject digests.

## Trust boundaries and residual limits

Keyless signing removes repository-held signing keys, but GitHub, its OIDC
issuer, Sigstore services and roots, the Actions runner, the signer workflow,
and the consumer policy all remain trusted. Provenance detects substitution
after a trusted build and binds bytes to source and workflow; it does not prove
source intent, dependency safety, build-step honesty, absence of runner
compromise, plugin harmlessness, or release recency. A compromised workflow can
falsify predicate prose it controls, so certificate identity and transparency
timestamps — not arbitrary predicate fields — carry identity. See the
[threat model](threat-model.md) and [ADR 0001](adr/0001-provenance-trust-model.md)
for the full matrix.
