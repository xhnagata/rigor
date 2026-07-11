# ADR 0001: Provenance trust model and consumer verification

- Status: Proposed for implementation in issues #25 and #26
- Date: 2026-07-11
- Issue: [#24](https://github.com/xhnagata/rigor/issues/24)
- Supersedes: the undifferentiated signing follow-up in [MVP limitations](../mvp-limitations.md)

## Context

Rigor currently has two useful but separate integrity mechanisms:

1. `rigor release-check` fails closed before a human tags a release unless the
   version metadata, changelog, committed `dist/rigor.cjs`, expected `main`
   commit, and required GitHub check agree. This prevents release mistakes but
   produces no consumer-verifiable provenance.
2. Pull-request CI obtains base and head SHAs from GitHub, derives the change set
   again, reads policy and evidence from Git objects, and reruns deterministic
   checks. This can reject fabricated local evidence at the merge boundary, but
   it does not authenticate a plugin after download.

The public repository is also the Claude Code marketplace. Its marketplace entry
uses `source: "./"`; Claude Code copies the repository plugin into a versioned
local cache, and `bin/rigor` executes the cached `dist/rigor.cjs`. The manifest's
semantic version controls cache updates, but it is not a cryptographic binding
between a version, a Git commit, and cached bytes. Releases currently have a tag
and GitHub release record but no attached binary assets or attestations.

The security objective is therefore narrow: let a party independent of the
release author verify that the bytes about to execute are the output of the
approved GitHub build workflow for the expected Rigor source revision. It is not
to sign every record or to prove that the source, build steps, model output, or
human decision was correct.

## Claims and terminology

- A **producer** emits an artifact or claim.
- An **independent verifier** obtains the subject bytes and evaluates a signed
  claim against expectations that the producer cannot change in the same action.
- A **trust root** is the verifier's configured basis for accepting an identity,
  not a checksum distributed beside the subject.
- **Configured model identity** is a requested provider/model name stored by
  Rigor. **Attested runtime identity** is a provider-authenticated statement
  about the runtime that actually served a request. The former never implies the
  latter.
- **Freshness** means the verifier knows that an otherwise valid statement is
  acceptable for the intended release/use now. A valid historical signature
  alone does not provide that policy decision.

## Current boundaries

| Boundary            | Current producer and transport                                                                                                        | Current verification and gap                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release             | Human tags a protected-PR `main` commit after `release-check`; GitHub hosts a release with no assets                                  | Tag target, CI result, and bundle rebuild are checked before tagging. A consumer does not repeat or authenticate those checks. Tags are lightweight and repository administrators retain bypass authority.                                        |
| Runtime artifact    | Release PR commits `dist/rigor.cjs`; `bin/rigor` executes it from the plugin root                                                     | `release-check` compares it with a fresh build. No signature or provenance is attached to the downloaded bytes.                                                                                                                                   |
| Plugin distribution | GitHub repository is a marketplace whose relative source is the repository root; Claude Code copies it into `~/.claude/plugins/cache` | Claude Code validates plugin structure and isolates cache paths, but the documented marketplace flow exposes no Rigor-specific pre-activation provenance policy hook. The version string is a cache key, not an authenticated digest expectation. |
| Local evidence      | The local CLI writes JSON under `.rigor/evidence/` and an event log; the change author commits selected JSON                          | Records contain hashes and linkage but are not signed. This is acceptable because PR CI distrusts contributor claims and independently derives Git facts and reruns checks. Outside that CI boundary, local evidence is only a local observation. |
| CI evidence         | GitHub Actions publishes check status/logs; `rigor` and `quality` run with `contents: read`                                           | GitHub and branch protection are the merge trust boundary. A check says what ran for a SHA, not that downloaded plugin bytes came from that run. Logs and check status are not build provenance.                                                  |
| Workflow identity   | Workflow files are reviewed source on `main`; GitHub supplies workflow context                                                        | No current attestation binds `dist/rigor.cjs` to GitHub's OIDC workflow identity. User-controlled predicate fields would not independently establish workflow identity.                                                                           |
| Model execution     | Claude Code or `codex-plugin-cc` invokes a provider; Rigor records configured or reported fields                                      | Rigor has no provider-signed runtime statement and deliberately records configured identity as `unverified`. Model output and cross-model agreement are advisory.                                                                                 |

## Threat and trust matrix

The following policy is the target state. “Fail closed” means the protected
operation does not proceed; it does not mean Rigor can stop an unmanaged user
from invoking arbitrary bytes.

### Identity and verification

| Subject                             | Producer                                                                 | Independent verifier                                                                                                                  | Trust root                                                                                                                 | Protected identity                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release tag                         | Human release operator and GitHub Git service                            | Release automation before publication; consumer policy before use                                                                     | Pinned `xhnagata/rigor` repository identity, protected release workflow identity, and consumer-approved release ref/commit | Version tag resolves to the approved source commit; a tag name alone is not protected identity                                                                                   |
| Source commit                       | GitHub-hosted source repository after protected PR merge                 | Release workflow, then consumer comparing provenance `sourceDigest`/`sourceRef` with its expectation                                  | GitHub repository identity and consumer-pinned commit or approved protected ref                                            | Full Git commit SHA in canonical `xhnagata/rigor`, not a branch display name or fork                                                                                             |
| `dist/rigor.cjs`                    | Dedicated GitHub-hosted release build from the source commit             | `gh attestation verify` plus consumer policy, before execution or promotion                                                           | GitHub Actions OIDC issuer, Sigstore trusted root, exact repository and signer-workflow expectation                        | SHA-256 subject digest, SLSA predicate type, source commit, workflow path, and preferably signer workflow digest                                                                 |
| Plugin distribution                 | GitHub repository/marketplace plus Claude Code's fetch and cache process | Organization seed-image/promotion pipeline or a verified-install wrapper; ordinary marketplace installation has no confirmed verifier | Consumer policy containing approved commit, complete plugin artifact digest/provenance identity, and allowed plugin source | The exact plugin tree promoted for use, including hooks, skills, agents, launcher, manifests, and `dist/rigor.cjs`; manifest version or an attested bundle alone is insufficient |
| Local evidence                      | Local Rigor executable and task actor                                    | PR CI for merge decisions; otherwise a named downstream consumer that re-derives facts                                                | Reviewed repository policy, Git object IDs, exact CI verifier bundle, and protected GitHub check                           | Task/contract linkage, head/tree state, changed paths, and rerun results; not author/model identity                                                                              |
| CI evidence                         | GitHub Actions jobs and GitHub Checks                                    | Branch ruleset and independent human reviewer; release gate for exact SHA                                                             | GitHub repository/ruleset identity and required check names                                                                | Check conclusion for the exact head SHA and immutable workflow run metadata                                                                                                      |
| Workflow identity                   | GitHub OIDC issuer for a particular Actions job                          | Sigstore/GitHub attestation verifier with signer restrictions                                                                         | Sigstore trusted root and `https://token.actions.githubusercontent.com`; consumer-pinned signer repository/workflow/digest | Certificate-backed repository and signer workflow identity; predicate prose is not identity                                                                                      |
| Claude/Codex runtime model identity | Only the serving provider could authoritatively produce it               | A consumer that validates a provider-signed statement and request/result binding; none exists in Rigor today                          | Provider-defined, independently distributed verification roots and schema, if a supported attestation becomes available    | Runtime deployment/model that served the bound request, distinct from configured and self-reported names                                                                         |

### Lifecycle and failure policy

| Subject                             | Replay/freshness risk                                                                                         | Revocation/rotation                                                                                                                   | Offline or unavailable behavior                                                                                                                                      | Policy                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release tag                         | An old valid tag may be replayed; a mutable/recreated tag could point elsewhere                               | Withdraw the release and deny its tag/commit/digest in consumer policy; require explicit approval for a replacement version           | Existing approved pinned version may continue under a documented maximum-staleness policy; no new version is accepted without current metadata                       | Fail closed for release/promotion mismatch; unmanaged historical installs are outside enforcement                                                                                                                                 |
| Source commit                       | A valid old commit can be presented as current; SHA does not express approval or recency                      | Consumer removes the commit from its allowlist or advances its approved release set; Git history deletion is not revocation           | Permit only a previously approved pinned commit when policy explicitly allows stale operation                                                                        | Fail closed for an unapproved commit, fork, ambiguous ref, or tag/commit disagreement                                                                                                                                             |
| `dist/rigor.cjs`                    | A valid old artifact and bundle can be replayed; provenance creation time alone is not release approval       | Deny compromised digests/source commits/workflows; refresh Sigstore/GitHub trusted roots and verifier tooling                         | Offline verification requires a pre-fetched bundle and trusted root. Accept only within a consumer-set root/bundle freshness window; otherwise do not install/update | Fail closed before first execution or promotion on missing, invalid, wrong-subject, wrong-source, or wrong-signer provenance                                                                                                      |
| Plugin distribution                 | Cache can retain a valid but old version; a second fetch can create TOCTOU between verification and execution | Disable/uninstall denied versions and rebuild approved seed/cache from newly verified bytes                                           | A previously verified immutable seed may remain usable by policy; marketplace update failure must not silently substitute unverified bytes                           | Fail closed for activation of a new/unverified version. If no pre-execution enforcement exists, #26 is blocked and no distribution guarantee is claimed                                                                           |
| Local evidence                      | Old evidence can be copied, timestamps can be authored locally, and the local writer can be replaced          | Schema/policy changes invalidate incompatible records; repository history can retain audit records but cannot make them authoritative | Local commands may create advisory records; authoritative PR decisions wait for CI                                                                                   | Fail closed at CI for stale/mismatched/unlinked evidence. Do not require signatures until a real downstream verifier and revocation policy exist                                                                                  |
| CI evidence                         | A successful run for another SHA/workflow can be cited; logs can expire                                       | Rerun required checks on the exact SHA, change required-check policy, or mark affected runs/releases untrusted                        | Release creation fails closed when the exact required check cannot be queried. Existing consumer approvals follow their own stale-use policy                         | Fail closed at merge/release for missing, unsuccessful, ambiguous, or unavailable required checks                                                                                                                                 |
| Workflow identity                   | A valid attestation from a different workflow/ref or compromised older workflow can be replayed               | Pin/rotate allowed signer workflow digest, deny compromised workflow/source commits, and refresh roots                                | Use a recent offline trusted-root snapshot and bundle only under explicit policy; otherwise verification is unavailable                                              | Fail closed unless repository, OIDC issuer, signer workflow, signer digest policy, source ref/digest, predicate type, and subject all match                                                                                       |
| Claude/Codex runtime model identity | A model string or old provider response can be copied to another attempt                                      | Defined only by a future provider attestation scheme; Rigor cannot invent provider revocation                                         | Record configured identity as `unverified` or runtime identity as unavailable; deterministic controls continue                                                       | Never fail a deterministic verification merely because runtime attestation is unavailable unless repository policy explicitly requires a supported provider attestation. Never upgrade an unverified name to a security guarantee |

## Options considered

| Option                                                                           | Independent identity and artifact binding                                                                                                                                                               | Consumer enforcement                                                                                                                                  | Offline/lifecycle                                                                                                                                                                                   | Decision                                                                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub Artifact Attestations (`actions/attest`)                                  | Uses GitHub OIDC-backed Sigstore bundles and defaults to SLSA provenance. GitHub CLI verifies subject digest, repository, predicate type, and can restrict signer workflow/digest and source ref/digest | Good verifier primitives, but Claude Code does not currently invoke them during marketplace activation                                                | GitHub documents bundle/trusted-root offline verification; stale roots do not reveal later revocation and must be refreshed. Attestations can be deleted, so consumer deny policy remains necessary | **Adopt** for `dist/rigor.cjs`, provided #26 supplies a pre-execution verifier                                                                   |
| Direct GitHub OIDC plus keyless Cosign/Sigstore                                  | Can bind an ephemeral certificate to GitHub workflow claims and record transparency evidence; avoids repository-held signing keys                                                                       | Requires Rigor to assemble and maintain more signing/distribution conventions and verifier commands that GitHub Artifact Attestations already provide | Sigstore roots rotate through TUF; offline verification and revocation still need explicit policy                                                                                                   | **Reject as the first implementation**; retain as an interoperability fallback if GitHub's service cannot meet availability or predicate needs   |
| SLSA-compatible provenance format without authenticated envelope                 | Standard fields improve traceability and testability                                                                                                                                                    | A consumer can inspect source/build parameters but cannot authenticate the producer                                                                   | Easy to archive; trivial to forge at Build L1                                                                                                                                                       | **Reject alone**; use SLSA v1 inside an authenticated GitHub attestation and make no SLSA level claim until requirements are assessed            |
| SLSA generic generator or reusable trusted builder                               | A hardened reusable workflow can narrow control over provenance and may support a stronger SLSA level                                                                                                   | Verifier can pin reusable signer workflow identity                                                                                                    | Adds builder maintenance and assessment burden                                                                                                                                                      | **Defer**; the small repository should first establish the artifact/consumer path. Consider later if threat analysis justifies a trusted builder |
| Checksum beside `dist/rigor.cjs`, in the same release, or in the same Git commit | Detects accidental corruption only when the checksum arrived through an independent trusted channel                                                                                                     | Same compromised distribution path can replace both values                                                                                            | No useful identity or revocation semantics                                                                                                                                                          | **Reject** as independent proof                                                                                                                  |
| Signed Git tag only                                                              | Can authenticate a tag creator under a separately managed key policy                                                                                                                                    | Does not prove which workflow built `dist/rigor.cjs` or bind installed bytes to build provenance                                                      | Long-lived key rotation/revocation and historical verification are operational burdens                                                                                                              | **Reject as sufficient provenance**; it may be defense in depth later                                                                            |
| Sign every local evidence JSON                                                   | Identifies the local signer only if keys and identity enrollment are solved                                                                                                                             | Current CI already distrusts claims and reruns checks; no other required consumer exists                                                              | Creates key, replay, rotation, and privacy burden without a decision point                                                                                                                          | **Reject** until a concrete independent consumer needs it                                                                                        |
| Manifest version, GitHub release page, CI badge, or model self-report            | Metadata/display signals without an authenticated subject binding                                                                                                                                       | No fail-closed byte-level decision                                                                                                                    | Staleness is easy to hide                                                                                                                                                                           | **Reject** as provenance                                                                                                                         |

GitHub Artifact Attestations add security beyond current CI re-derivation only
when a consumer verifies the exact downloaded subject against independently held
identity and source expectations. Generating and publishing attestations without
that decision point adds audit data, not an enforced distribution guarantee.

## Decision

Adopt GitHub Artifact Attestations as the preferred envelope and distribution
service for SLSA v1 build provenance over the release `dist/rigor.cjs` and a
deterministically packaged complete plugin artifact. Attesting only the bundle
would leave hooks, skills, agents, manifests, and the launcher substitutable.
Use a dedicated, GitHub-hosted release workflow with least privilege and no
long-lived signing key. The required consumer policy is:

- exact bundle and complete-plugin subject bytes and SHA-256 digests;
- predicate type `https://slsa.dev/provenance/v1`;
- repository `xhnagata/rigor`;
- OIDC issuer `https://token.actions.githubusercontent.com`;
- exact signer workflow path and an approved signer workflow digest/ref policy;
- exact source commit equal to the approved release tag target;
- GitHub-hosted runner requirement unless a separately assessed builder is
  approved;
- an allow/deny and maximum-staleness policy independent of the attestation.

The verifier must use GitHub CLI restrictions such as `--repo`,
`--signer-workflow`, `--signer-digest`, `--source-digest`, `--source-ref`, and
`--deny-self-hosted-runners`, or implement equivalent checks. It must not trust
workflow-controlled predicate fields as certificate-backed identity.

No SLSA Build Level is claimed by this ADR. #25 may demonstrate that the
selected format is SLSA-compatible; a level claim requires a separate assessment
of the final build platform and provenance generation path.

### Consumer enforcement points

| Candidate point                                      | Can inspect the exact bytes that execute?                                                                                                                                             | Can fail before execution?                                                          | Result                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Claude Code marketplace install/update itself        | The documented cache contains the executing bytes, but no attestation-policy callback or required verification command is documented                                                  | Not currently demonstrated                                                          | **Not an enforcement point yet**; #26 must test or upstream-confirm it |
| Organization image/seed promotion pipeline           | Yes, if it downloads an immutable commit/tree, verifies the complete plugin artifact and its `dist/rigor.cjs`, and promotes those same bytes into a read-only Claude Code plugin seed | Yes                                                                                 | **Recommended managed consumer/verifier**                              |
| Verified local clone used with `claude --plugin-dir` | Yes, if verification and execution use the same immutable local tree and mutation is prevented/detected                                                                               | Yes for a disciplined wrapper; ordinary manual use is bypassable                    | Useful developer path, not an organization-wide guarantee              |
| Post-install cache scanner                           | Usually, but the plugin may already have loaded and cache internals can change                                                                                                        | No reliable pre-use guarantee                                                       | Monitoring only; reject as primary control                             |
| PR CI or release workflow                            | Sees source/build output before distribution                                                                                                                                          | It can block publication, not consumer execution or a compromised distribution path | Necessary producer control, insufficient consumer enforcement          |
| Manual README command                                | Can verify a user-selected file                                                                                                                                                       | User can skip it and a later marketplace fetch may differ                           | Guidance only; no security guarantee                                   |

Until one of the first three paths is implemented and tested with the exact
bytes subsequently executed, #26 is blocked by a missing consumer boundary.

## Implementation split

### #25 — independently testable producer provenance

Start only after this ADR is approved and a repository owner confirms GitHub
Artifact Attestations are available for the public repository.

1. Add a dedicated release-build workflow triggered only for the approved
   release path. Build `dist/rigor.cjs` from the checked-out full source commit
   with pinned dependencies and GitHub-hosted runners. Fork pull requests and
   untrusted caller inputs must not be able to invoke a trusted attestation job.
2. Compare the produced bundle with the committed release bundle and fail on a
   mismatch. Deterministically package the complete distributable plugin file set
   so hooks, skills, agents, launcher, manifests, and bundle share a verifiable
   release subject. Do not attest arbitrary caller-supplied paths or digests.
3. Grant only `contents: read`, `id-token: write`, and `attestations: write` to
   the attestation job; pin third-party actions to reviewed full commit SHAs.
4. Generate GitHub Artifact Attestations for `dist/rigor.cjs` and the complete
   plugin package using SLSA v1 provenance. Record the release tag, source
   commit, workflow run, subject digests, build/package command and relevant tool
   versions, and downloadable subject/bundle locations as release metadata.
5. Add tests that build/package twice, assert deterministic bundle and package
   digests, inspect the attestation predicate/schema, and show verification
   succeeds only for the expected subjects/repository/workflow/source. Negative
   tests must cover changed bundle bytes, changed non-bundle plugin files, wrong
   source SHA, wrong signer, wrong predicate, absent attestation, and self-hosted
   runner rejection.
6. Document root rotation, attestation deletion/withdrawal, compromised digest
   denylisting, offline bundle/root refresh, and release rollback. Do not create
   keys or claim a SLSA level.

#25 is complete when a test release artifact can be verified independently by
policy; publishing an attestation alone is not completion of #26.

### #26 — independently testable consumer enforcement

1. Determine experimentally and, where necessary, with an upstream Claude Code
   answer whether install/update offers a supported pre-activation hook over the
   exact cached plugin bytes. Record Claude Code version and cache/update behavior.
2. If it does, implement verification before enable/load and negative tests for
   tampered bundle or other plugin bytes, absent/invalid/wrong-signer/wrong-source
   provenance, replayed denied versions, offline stale roots, and update races.
   Confirm the verified complete plugin tree is the tree whose hooks, skills,
   agents, and `bin/rigor` execute.
3. If it does not, implement and document a managed promotion path: verify an
   immutable plugin tree and attested bundle, then promote the same bytes to a
   read-only seed or approved local source. Test that ordinary marketplace/network
   updates cannot replace the approved bytes.
4. Make new install/update fail closed. Define whether an already verified pinned
   version may continue offline, its maximum metadata/root age, and how emergency
   deny rules override that exception.
5. Document migration from the ordinary marketplace cache, rollback to a still
   approved immutable version, and break-glass recovery. A break-glass activation
   requires an independent human approval and an auditable expiration; it is not
   reported as verified.
6. Keep personal marketplace users outside the guarantee unless they use the
   verified wrapper/path. State bypassability plainly.

#26 remains blocked if no supported mechanism can verify the exact plugin bytes
before hooks, skills, agents, or `bin/rigor` can execute; if verification fetches
one object but Claude Code executes a separately fetched copy; or if the consumer
cannot hold signer/source/deny expectations independently of the producer.

## Consequences and limitations

- Keyless signing removes repository-held signing keys, but GitHub, its OIDC
  issuer, Sigstore services/roots, the Actions runner, the selected workflow, and
  the consumer policy remain trusted.
- Provenance detects substitution after a trusted build and ties bytes to source
  and workflow. It does not prove source intent, dependency safety, build-step
  honesty, absence of runner compromise, plugin harmlessness, or release recency.
- A compromised workflow can falsify predicate content it controls. Certificate
  identity and transparency timestamps are stronger than arbitrary predicate
  prose; a hardened reusable builder is a possible later improvement.
- Attestation deletion is not retroactive revocation of already downloaded
  bundles. Consumers need explicit deny rules and refreshed roots/metadata.
- Local evidence continues to rely on independent CI re-derivation, not blanket
  signatures. Runtime model identity remains unavailable/unverified unless a
  provider supplies a verifiable, request-bound attestation and a consumer
  enforces it.
- The complete plugin packaging format and file inclusion rules are an #25 design
  detail requiring human review. A bundle-only attestation must not be described
  as plugin-distribution integrity.

## Primary references

- GitHub, [Using artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- GitHub CLI, [`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify)
- GitHub, [Verifying attestations offline](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline)
- GitHub, [Managing the lifecycle of artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/manage-attestations)
- GitHub, [OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- Sigstore, [Signing overview](https://docs.sigstore.dev/cosign/signing/overview/)
- Sigstore, [Security model](https://docs.sigstore.dev/about/security/)
- SLSA v1.2, [Build track basics](https://slsa.dev/spec/v1.2/build-track-basics)
- SLSA v1.2, [Verifying artifacts](https://slsa.dev/spec/v1.2/verifying-artifacts)
- SLSA v1.2, [Build provenance](https://slsa.dev/spec/v1.2/build-provenance)
- Claude Code, [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- Claude Code, [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- OpenAI, [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
