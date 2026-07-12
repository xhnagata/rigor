# Release runbook

Releases of Rigor reach `main` only through a protected pull request whose
required checks are green, and they are tagged and published only after the
deterministic `rigor release-check` gate passes. Rigor itself never tags,
pushes, or changes any GitHub setting; every step below is a human-authorized
action.

This gate is a producer-side release control, not consumer-verifiable
provenance. It does not sign or attest `dist/rigor.cjs`, authenticate a plugin
cache, or prove to a downloader that the bytes it received came from the checked
workflow and source commit. [ADR 0001](adr/0001-provenance-trust-model.md)
defines the proposed provenance design and treats the missing pre-execution
consumer verifier as a blocker for an end-to-end distribution guarantee.

## The protected path

Cut a release only from a `main` commit that reached `main` through a protected
pull request with the required checks (`rigor` and `quality`) green. Never
direct-push a release commit to `main`. The release commit — the one that bumps
versions and rebuilds the bundle — must land through the same PR flow as any
other change.

The `v0.2.0` tag did not follow this process: that release commit bypassed the
pull-request and required-check rules using administrator privileges. That is
not the promised process, and later releases must not repeat it. It is recorded
here so the exception is visible rather than assumed to be routine.

## Administrator bypass authority

Rigor cannot change GitHub settings, so branch protection must be verified, not
assumed. Use the read-only verifier before every release:

```sh
rigor governance --repo xhnagata/rigor
```

The repository's current `main-governance` ruleset allows a "Repository admin"
bypass, so an administrator _can_ merge or push past the rules. The release
process therefore depends on the human owner choosing not to exercise that
bypass for release commits. Any unavoidable bypass must be recorded (as the
`v0.2.0` note above records one). Treat admin-applicability of the rules as
something to confirm with `rigor governance` and the GitHub ruleset settings,
not as a guarantee.

## The pre-tag gate

Before tagging, run the deterministic gate against the merged `main` commit:

```sh
rigor release-check \
  --version X.Y.Z \
  --branch main \
  --expected-sha <merged-main-sha> \
  --repo xhnagata/rigor \
  --required-check quality
```

Each finding:

- `clean-tree` — the worktree has no uncommitted changes.
- `version-sync` — `package.json` and `.claude-plugin/plugin.json` both declare
  the requested version.
- `changelog-entry` — `CHANGELOG.md` has a section for the requested version.
- `bundle-built` — the committed `dist/rigor.cjs` is byte-identical to a fresh
  build (the check builds to a throwaway file and never mutates `dist`).
- `ci-bundle-sync` — the committed `.rigor/rigor-ci.cjs` is byte-identical to
  the committed `dist/rigor.cjs`. This applies only in this repository, where
  both files exist; in a consumer repository that carries only the setup-written
  `.rigor/rigor-ci.cjs` and no source `dist/` tree the pair is absent and the
  finding is satisfied as not-applicable, so it never fails a consumer.
- `expected-branch` — `HEAD` is on the expected branch (`main` by default).
- `expected-commit` — `HEAD` matches `--expected-sha` when one is pinned.
- `ci-success` — the required GitHub check(s) completed successfully for the
  exact `HEAD` SHA.

On a merged `main` commit the `CI` workflow's `quality` job is the check that
runs for that push, so `--required-check quality` is the correct gate for a
release SHA. The `rigor` check runs only on pull requests, so it does not exist
on the `main` push SHA; requiring it here (for example `--required-check
rigor,quality`) would fail closed and never pass. Pass several names only when
every one of them produces a check run for the SHA being tagged.

Overall PASS requires the remote CI check. Omitting `--repo` leaves
`ci-success` `unverifiable`, and the overall status fails closed rather than
reporting `passed`; a required check that is present but not successful is a
proven negative and fails. Supply a least-privilege read token through
`RIGOR_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `GH_TOKEN`; the command issues only GET
requests to `api.github.com`.

## Exact tag and publish procedure

All steps are human-authorized; Rigor performs none of them.

1. In `CHANGELOG.md`, rename the `## Unreleased` heading to `## X.Y.Z - DATE`.
2. Bump the version in both `package.json` and `.claude-plugin/plugin.json` to
   `X.Y.Z`. The manifest version is the Claude Code cache version, so it must
   change for users to receive an update.
3. Run `npm run build`. Whenever the rebuilt `dist/rigor.cjs` bytes changed,
   also refresh the pinned CI verifier so the two stay byte-identical:
   `/bin/cp -f dist/rigor.cjs .rigor/rigor-ci.cjs`. Commit both files. Any
   release whose `dist/rigor.cjs` bytes changed MUST regenerate
   `.rigor/rigor-ci.cjs` in the same commit; the `rigor` PR gate executes the
   committed `.rigor/rigor-ci.cjs`, so a stale copy silently enforces old
   verification logic (the #29 / #44 recurrence). The `ci-bundle-sync`
   release-check finding and the `test/ci-bundle.test.ts` check in
   `npm run test:all` both fail loudly on drift.
4. Open a pull request with these changes.
5. Obtain the required checks (`rigor` and `quality`) green and the required
   approval, then merge the pull request. Never direct-push the release commit.
6. On the merged `main` SHA, run the pre-tag gate above with
   `--expected-sha <merged-main-sha>` and `--repo xhnagata/rigor`.
7. Only when the gate reports overall `passed`, tag and publish:

   ```sh
   git tag vX.Y.Z <merged-main-sha>
   git push origin vX.Y.Z
   ```

Until issues #25 and #26 implement and validate ADR 0001, do not describe this
procedure as producing an attested release. A tag, release page, CI success, or
checksum placed beside the same artifact is not independent proof. The current
release may be described only as a bundle reproducibly checked before tagging.

When provenance is implemented, release documentation must additionally identify
the attested bundle and complete-plugin subject digests, source commit equal to
the tag target, signer workflow identity, attestation bundles, withdrawal/deny
procedure, and the exact consumer command or promotion boundary that fails
closed before execution. Those future steps supplement rather than replace this
pre-tag gate.

See the [threat model](threat-model.md) for the read-only GitHub API trust
boundary that `rigor governance` and `rigor release-check` rely on.
