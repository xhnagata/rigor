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
- [#26](https://github.com/xhnagata/rigor/issues/26) consumer enforcement is
  now **implemented** via a verified-install/managed-promotion boundary (see
  ["Consumer enforcement (#26)"](#consumer-enforcement-26) below) — but ONLY
  for a consumer who runs
  [`scripts/install-verified.mjs`](../scripts/install-verified.mjs) from
  outside the plugin, holding its own policy independently. The ordinary
  Claude Code marketplace install/update flow still has **no confirmed
  pre-activation verification point** that checks the exact cached bytes
  before hooks, skills, agents, or `bin/rigor` execute — this was
  experimentally observed in Claude Code 2.1.207, which exposes only
  session-scoped `--plugin-dir`/`--plugin-url` explicit loads, not a
  marketplace-install callback — so an unmanaged personal marketplace install
  remains outside this guarantee and there is no end-to-end distribution
  guarantee for it.
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

## Consumer enforcement (#26)

[ADR 0001](adr/0001-provenance-trust-model.md) names three viable pre-execution
consumer-enforcement boundaries and rejects a fourth class outright: a
marketplace pre-activation hook (**not available** — see below), an
organization seed/promotion pipeline (**recommended**), and a verified-local
`claude --plugin-dir` wrapper (**implemented as reference code here**).
Explicitly **rejected** as enforcement: a plugin `SessionStart` self-check
(runs only after the plugin already loaded), a verifier shipped _inside_ the
distribution it protects with no independent policy, manual README guidance a
user can skip, and a checksum/manifest distributed beside the artifact.

### The marketplace has no pre-activation hook

Experimentally confirmed in **Claude Code 2.1.207**: the ordinary Claude Code
marketplace install/update flow copies the repository plugin into
`~/.claude/plugins/cache` and executes it with no documented callback that a
producer or consumer can use to verify the exact cached bytes before
hooks/skills/agents/`bin/rigor` load. `claude --plugin-dir <path>` **does**
exist and loads an explicit local directory (or `.zip`) for the session, which
is what makes a verified-local-tree boundary real: verification and execution
can share the same immutable bytes. This is a session-scoped explicit load,
not a marketplace-install callback — it does not add any hook to the ordinary
marketplace path.

### The verified-install / managed-promotion wrapper

[`scripts/install-verified.mjs`](../scripts/install-verified.mjs) is a
reference implementation of the verified-local-tree / managed-promotion path.
It is producer-provided REFERENCE code, but it is only an enforcement boundary
when a **consumer** copies it (and its policy: approved versions, denylist,
break-glass permission, offline age limits) to a location **outside** the
plugin tree it protects and runs it from there. A verifier or policy shipped
_inside_ the distribution it verifies is not itself a boundary — the same
unreviewed change that could compromise the plugin could also disable or
rewrite a verifier living beside it; only an independently held copy and
policy break that circularity.

End to end, the wrapper:

1. downloads the complete-plugin archive and recomputes its SHA-256 (never
   trusts a checksum distributed beside it);
2. verifies that digest against GitHub Artifact Attestations and the
   consumer's independently held policy, reusing every decision function
   exported by [`scripts/verify-provenance.mjs`](../scripts/verify-provenance.mjs)
   (`evaluateVerification`, the gh version/shape guards) plus the
   detached-manifest mix-and-match check (`compareManifestToArtifacts`);
3. confirms the pinned version+commit is in the consumer's approved set and
   not denied (`checkApproval` — replay/freshness);
4. on success, extracts ONLY the verified bytes — the in-memory attested
   buffer written into an `mkdtemp` private directory (mode 0700, an
   unpredictable name), never the on-disk archive path, which could be swapped
   after the initial read — into a fresh, read-only local seed directory, then
   confirms the seed is EXACTLY the attested payload two ways:
   (a) [`collectSeedFiles`](../scripts/package-plugin.mjs) walks the WHOLE seed
   and rejects any extra file, extra directory, symlink, non-regular node, or
   unexpected executable bit, so an injected extra file (e.g. a root-level
   `.mcp.json` that Claude Code would load) cannot ride along with a
   bytewise-matching allowlist subset; and (b) the seed's uncompressed-tar
   digest (`buildArchiveTar`) must equal the `gunzip` of the archive we hold
   (`checkSeedIntegrity` — closes the TOCTOU gap between what was verified and
   what will execute). The digest comparison is at the tar layer, not the
   recompressed `.tar.gz` digest, so it is deterministic across every supported
   consumer Node/zlib build; a gzip-digest comparison would reject a legitimate
   attested release whenever the consumer's `zlib` deflate differs from the
   pinned producer runtime (issue #26);
5. prints (or, with `--launch`, executes) `claude --plugin-dir <seed>` so the
   session loads the exact tree that was verified;
6. refuses and exits non-zero on ANY verification, approval, freshness, or
   seed-integrity failure, and never prints `verified` on failure.

### Install, upgrade, and migration

To adopt the wrapper: copy `scripts/install-verified.mjs`,
`scripts/verify-provenance.mjs`, and `scripts/package-plugin.mjs` (the wrapper
imports `collectSeedFiles`/`buildArchiveTar` from it to strictly re-derive the
seed's tar) outside the plugin tree (for example, into an internal tooling
repository), write a consumer-held policy file (approved
versions, denylist, offline age limits, break-glass permission), and run:

```sh
node install-verified.mjs \
  --version X.Y.Z --commit <release-commit-sha> \
  --archive rigor-X.Y.Z.tar.gz --manifest rigor-X.Y.Z.release-manifest.json \
  --seed ~/.rigor-verified/current \
  --policy consumer-policy.json --denylist consumer-denylist.json \
  --source-digest <release-commit-sha> --signer-digest <workflow-commit-sha>
```

Migrating from the ordinary marketplace cache means STOPPING use of the
marketplace-managed plugin (or leaving it installed but launching sessions
with `--plugin-dir` instead) and always launching with the printed
`claude --plugin-dir <seed>` command, or `--launch` to have the wrapper exec
it directly. An upgrade is simply re-running the wrapper against a new
version's archive once the consumer has approved it (added it to
`approvedVersions`); the previous seed is replaced only after the new bytes
verify and their extracted-tree contents match the attested archive.

### Rollback

Rollback re-points the wrapper at a previously approved, still-trusted version
**by its pinned commit and subject digests, not by tag name** (a tag can move;
a commit and a verified digest cannot): update the consumer's
`approvedVersions` to the prior `{ version, commit }` pair, deny the withdrawn
version's tag/commit/digests in the denylist, and re-run the wrapper. This
mirrors [Release rollback](#release-rollback) above and never trusts the
wrapper's own receipt to decide which version is safe.

### Break-glass (never reported as verified)

`--break-glass <file>` supplies an explicit, time-bounded exception used ONLY
when verification is impossible or failed. It requires an independent human
`approver` (not the wrapper, not the release), a bounded lifetime (default
72 hours, `expiresAtMs - issuedAtMs`), an unexpired `expiresAtMs`, and
`verified: false` — a break-glass activation must never claim to be verified.
The wrapper prints a `BREAK-GLASS (NOT verified)` banner and records
`verified: false` in its receipt on this path; it is an emergency-recovery
exception, not a substitute for verification, and requires
`policy.allowBreakGlass === true` to be reachable at all.

### Offline last-known-good (max age)

When offline (or `gh`/the attestation service is unavailable), the wrapper may
continue an **already-verified pinned** seed instead of promoting anything
new, but only when `policy.allowOfflineLastKnownGood === true`, the pinned
version's approval still holds, and its freshness (the consumer's trusted-root
and offline-bundle max-age policy — 7 and 30 days by default, see
["Consumer-held policy"](#consumer-held-policy-not-shipped-with-the-release)
above) has not been exceeded. It never promotes new or unverified bytes; a
new/unverified version while offline, or a pinned version beyond its max age
with no break-glass exception, refuses.

### Bypassability (stated plainly)

This boundary protects only a consumer who runs the wrapper from outside the
plugin with independently held policy. A personal marketplace user who
installs Rigor the ordinary way and never uses `install-verified.mjs` or
`--plugin-dir` is **outside this guarantee**: Rigor cannot stop an unmanaged
user from invoking arbitrary bytes, and the ordinary marketplace path has no
pre-activation verifier to enforce anything even if one were desired. No SLSA
Build Level is claimed, no native Claude Code marketplace pre-activation
verifier exists, and configured model identity remains `unverified`.

## Immutable releases (owner-enabled; pins remain independent)

GitHub immutable releases are a complementary control that locks a published
tag and its assets. **The repository owner has enabled immutable releases**
(an out-of-band, repository-settings action outside this codebase's control —
Rigor performs no GitHub configuration writes). Immutable releases make a
published tag and its assets resistant to retroactive modification, but they
are not a substitute for build provenance and do not change consumer policy:
keep pinning the **exact source commit and subject digests** rather than the
tag name, and keep an independent deny/staleness policy, because attestation
or release **deletion is still not retroactive revocation** of already
downloaded bytes (see ["Attestation deletion, withdrawal, and
revocation"](#attestation-deletion-withdrawal-and-revocation) above).

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
