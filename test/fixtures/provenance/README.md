# Provenance verifier fixtures

These fixtures drive the offline decision-logic tests in
[`../../provenance.test.ts`](../../provenance.test.ts). They never contact the
network or run the `gh` CLI; they feed pre-parsed JSON to the pure functions
exported from [`../../../scripts/verify-provenance.mjs`](../../../scripts/verify-provenance.mjs).

## Assumed `gh attestation verify --format json` shape

The verifier consumes the JSON that `gh attestation verify … --format json`
prints, projected to the fields it asserts on. That output is an **array** of
results, one per matching attestation. Each result has the shape below. The
fixtures reproduce only the fields the verifier reads; a real `gh` payload
carries more (full Sigstore bundle, timestamps, TLog entries) which the verifier
ignores.

```jsonc
[
  {
    "attestation": { "bundle": { "mediaType": "…" } },
    "verificationResult": {
      "statement": {
        "_type": "https://in-toto.io/Statement/v1",
        "predicateType": "https://slsa.dev/provenance/v1",
        "subject": [
          { "name": "rigor.cjs", "digest": { "sha256": "<64-hex>" } },
        ],
      },
      "signature": {
        "certificate": {
          "issuer": "https://token.actions.githubusercontent.com",
          "sourceRepositoryURI": "https://github.com/xhnagata/rigor",
          "sourceRepositoryID": "1296432215",
          "sourceRepositoryRef": "refs/tags/vX.Y.Z",
          "sourceRepositoryDigest": "<40-hex>",
          "buildSignerURI": "https://github.com/xhnagata/rigor/.github/workflows/release.yml@refs/tags/vX.Y.Z",
          "buildSignerDigest": "<40-hex>",
          "runnerEnvironment": "github-hosted",
          "buildTrigger": "push",
          "extensions": { "1.3.6.1.4.1.57264.1.14": "1296432215" },
        },
      },
    },
  },
]
```

The `certificate` object mirrors the Sigstore certificate **summary** fields
(`sourceRepository*`, `buildSigner*`, `runnerEnvironment`, `buildTrigger`,
`issuer`). The numeric repository id is the value of Fulcio extension OID
`1.3.6.1.4.1.57264.1.14`. A real gh 2.96.0 payload carries it as
`sourceRepositoryIdentifier` (see `positive-real-v0.13.0.json` below); the
verifier reads that field first, then falls back to the older/hand-authored
`sourceRepositoryID` summary field, then the raw `extensions` map, so a real
capture and the synthetic `positive.json`/`empty.json` fixtures below both
verify. `validateGhShape` rejects a certificate that carries none of the
three.

### Certificate-backed checks the `gh` flags do NOT enforce

`--repo`, `--signer-workflow`, `--signer-digest`, `--source-digest`,
`--source-ref`, and `--deny-self-hosted-runners` constrain much of the identity,
but the numeric repository id, the build trigger event (`push`), the tag
pattern, and the runner-environment class are certificate-extension values that
those flags do not check. The verifier re-checks all of them from the JSON so a
changed invocation cannot silently drop a control.

## Fixtures

- `positive.json` — one valid, hand-authored result. `evaluateVerification`
  returns `ok: true` under a policy whose `expectedSubjectSha256` is 64 `a`,
  `expectedSourceDigest` / `expectedSignerDigest` are 40 `c`, and tag
  `v0.11.0`.
- `empty.json` — `[]`, an absent attestation (also how a nonzero `gh` exit or
  empty stdout is normalized). Always `ok: false`.
- `positive-real-v0.13.0.json` — a **real capture**, not hand-authored, of
  `gh attestation verify dist/rigor.cjs --repo xhnagata/rigor --signer-workflow
xhnagata/rigor/.github/workflows/release.yml --format json` run against the
  actual `v0.13.0` release, trimmed to only the fields the verifier reads
  (`verificationResult.statement` and `verificationResult.signature.certificate`;
  the full Sigstore bundle, raw certificate bytes, and transparency-log entries
  are dropped). It is public certificate data only — no secrets, no absolute
  paths, no signing material. It pins the exact gh 2.96.0 JSON shape described
  above: the repository id lives in `sourceRepositoryIdentifier`
  (`sourceRepositoryOwnerIdentifier` `1906309` is also present), not
  `sourceRepositoryID`/`extensions`. Other real values:
  `sourceRepositoryDigest`/`buildSignerDigest` equal the release commit
  `e159a4baf82d19193ca6d473a5fc5edd92282796`, `sourceRepositoryRef` is
  `refs/tags/v0.13.0`, and the statement subject `sha256` is the real
  `dist/rigor.cjs` digest
  `8b3c17a3d968c6dc60ef717b1853d86023d1088a4d6a5011c72eba73df272675`. Tests
  assert the positive verification (pinned to this release) and every
  negative (wrong repository id, wrong source digest, wrong signer, wrong
  predicate, self-hosted runner, a different valid tag ref) by mutating a
  clone of this fixture, mirroring the `positive.json` negative pattern below.

Every other negative case (changed bundle bytes, changed non-bundle plugin file,
mismatched detached manifest, wrong source SHA, wrong signer, wrong predicate,
self-hosted runner) is produced in the test by cloning a positive fixture and
mutating a single field or by supplying a mismatched digest/policy input, so the
positive and negative inputs differ in exactly one dimension.

## Pinning and freshness (consumer-held policy, documented, not in fixtures)

The real verifier requires a pinned `gh` CLI version — enforced in code via
the exported `parseGhVersion`/`isSupportedGhVersion` and the JSON
shape-validator `validateGhShape` (a different major, a minor below the
configured floor, an unparseable version, or an unrecognized JSON shape all
fail closed) — plus a Sigstore trusted root refreshed at least every 7 days,
an offline attestation/bundle no older than 30 days, and a
consumer-distributed compromised-digest denylist. See
[`docs/provenance.md`](../../../docs/provenance.md).
