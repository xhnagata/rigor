// Fail-closed consumer verifier for ADR 0001 producer provenance (#25).
//
// This verifies a downloaded subject (the bundle, the plugin archive, or the
// detached manifest) against GitHub Artifact Attestations AND against a locally
// held consumer policy. It is a producer-provided reference verifier; the
// consumer holds the policy independently of the Rigor release. #25 delivers
// producer provenance only. The ordinary Claude Code marketplace still has NO
// confirmed pre-activation verifier that checks the exact cached bytes before
// hooks/skills/agents/bin execute, so #26 remains blocked and this script does
// NOT provide an end-to-end distribution guarantee. It never claims a SLSA
// Build Level and never verifies runtime model identity.
//
// The CLI wrapper runs:
//   gh attestation verify <subject> --repo xhnagata/rigor \
//     --signer-workflow xhnagata/rigor/.github/workflows/release.yml \
//     --signer-digest <sha> --source-digest <sha> \
//     --source-ref refs/tags/vX.Y.Z \
//     --cert-oidc-issuer https://token.actions.githubusercontent.com \
//     --deny-self-hosted-runners \
//     --predicate-type https://slsa.dev/provenance/v1 --format json
//
// The gh flags DO NOT enforce the numeric repository id, the build trigger
// event, the tag pattern, or the runner-environment class, so this verifier
// re-checks all of them from the returned certificate JSON. It fails closed on
// a nonzero gh exit, empty output, an unknown JSON shape, ambiguous/multiple
// conflicting results, a denied digest, missing freshness, or any mismatch, and
// never prints "verified" on failure.
//
// OPERATIONAL POLICY (consumer-held, not shipped with the release):
//   - Pin the gh CLI version used for verification; record it in the audit log.
//   - Refresh the Sigstore trusted root at least every 7 days; a stale root
//     cannot reveal a later revocation.
//   - For offline verification, accept a pre-fetched attestation bundle + root
//     only within a maximum age of 30 days.
//   - The compromised-digest denylist is distributed and maintained by the
//     CONSUMER (via --denylist), never sourced from the Rigor release; a
//     release cannot remove itself from a consumer's deny policy.
//   - Attestation deletion is not retroactive revocation; keep explicit deny
//     rules and refresh roots/metadata.
//
// ALL decision logic lives in exported pure functions below. The process-
// spawning gh call and stdout live in the thin main() wrapper, which is guarded
// by an import.meta.url main check and is not exercised by tests.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import process from "node:process";

const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const REPOSITORY = "xhnagata/rigor";
const REPOSITORY_URI = "https://github.com/xhnagata/rigor";
const REPOSITORY_ID = "1296432215";
const SIGNER_WORKFLOW = "xhnagata/rigor/.github/workflows/release.yml";
const SOURCE_REF_RE = "^refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$";
const DAY_MS = 24 * 60 * 60 * 1000;

/** SHA-256 hex of a buffer. */
export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Build a default consumer policy, overridable per field. */
export function defaultPolicy(overrides = {}) {
  return {
    repository: REPOSITORY,
    repositoryUri: REPOSITORY_URI,
    repositoryId: REPOSITORY_ID,
    signerWorkflow: SIGNER_WORKFLOW,
    oidcIssuer: OIDC_ISSUER,
    predicateType: PREDICATE_TYPE,
    sourceRefPattern: SOURCE_REF_RE,
    buildTrigger: "push",
    runnerEnvironment: "github-hosted",
    denySelfHostedRunners: true,
    denylist: [],
    trustedRootMaxAgeDays: 7,
    offlineMaxAgeDays: 30,
    // expectedSubjectSha256, expectedSourceDigest, expectedSignerDigest,
    // trustedRootFetchedAtMs, offlineBundleFetchedAtMs, nowMs are supplied by
    // the caller for the specific subject/session.
    ...overrides,
  };
}

/**
 * Is `digest` denied? Fail closed: a missing/empty digest counts as denied
 * because we cannot prove it is safe. Comparison is case-insensitive hex.
 */
export function isDenied(digest, denylist) {
  if (typeof digest !== "string" || digest.length === 0) return true;
  const target = digest.toLowerCase();
  return (denylist ?? []).some(
    (d) => typeof d === "string" && d.toLowerCase() === target,
  );
}

/**
 * Freshness policy for offline/stale verification. Fail closed when a required
 * timestamp is absent (freshness cannot be proven) or an age exceeds its cap.
 */
export function freshnessOk(policy, nowMs) {
  const reasons = [];
  const maxRoot = (policy.trustedRootMaxAgeDays ?? 7) * DAY_MS;
  const maxOffline = (policy.offlineMaxAgeDays ?? 30) * DAY_MS;
  if (typeof policy.trustedRootFetchedAtMs !== "number") {
    reasons.push("trusted-root freshness unknown");
  } else if (nowMs - policy.trustedRootFetchedAtMs > maxRoot) {
    reasons.push("trusted root exceeds max age");
  } else if (nowMs < policy.trustedRootFetchedAtMs) {
    reasons.push("trusted-root timestamp is in the future");
  }
  if (typeof policy.offlineBundleFetchedAtMs === "number") {
    if (nowMs - policy.offlineBundleFetchedAtMs > maxOffline)
      reasons.push("offline bundle exceeds max age");
    else if (nowMs < policy.offlineBundleFetchedAtMs)
      reasons.push("offline-bundle timestamp is in the future");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Does the in-toto statement's subject carry the expected SHA-256 digest?
 */
export function checkSubjectDigest(statement, expectedSha256) {
  const reasons = [];
  const subjects = statement?.subject;
  if (!Array.isArray(subjects) || subjects.length === 0) {
    reasons.push("statement has no subject");
    return { ok: false, reasons };
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? "")) {
    reasons.push("expected subject sha256 is not 64-hex");
    return { ok: false, reasons };
  }
  const match = subjects.some(
    (s) =>
      (s?.digest?.sha256 ?? "").toLowerCase() === expectedSha256.toLowerCase(),
  );
  if (!match) reasons.push("subject digest does not match expected sha256");
  return { ok: reasons.length === 0, reasons };
}

/**
 * Enforce the certificate-backed identity that the gh flags do NOT enforce plus
 * the ones they do (re-checked here so a change of invocation cannot silently
 * drop a control). `cert` is the sigstore certificate summary object.
 */
export function checkCertificateExtensions(cert, policy) {
  const reasons = [];
  if (!cert || typeof cert !== "object") {
    return { ok: false, reasons: ["certificate summary missing"] };
  }
  // Numeric repository id: SAN/extension OID 1.3.6.1.4.1.57264.1.14. Prefer the
  // summary field; fall back to the raw extension map.
  const repoId =
    cert.sourceRepositoryID ??
    cert.extensions?.["1.3.6.1.4.1.57264.1.14"] ??
    null;
  // Normalize: some gh builds may emit the id as a JSON number. Compare as a
  // string so an operator cannot loosen the check on a numeric payload, but
  // still fail closed when the id is absent (null).
  if (repoId === null || String(repoId) !== policy.repositoryId)
    reasons.push(`repository id ${repoId} != ${policy.repositoryId}`);

  if (cert.issuer !== policy.oidcIssuer)
    reasons.push(`oidc issuer mismatch: ${cert.issuer}`);

  if (cert.sourceRepositoryURI !== policy.repositoryUri)
    reasons.push(`source repository uri mismatch: ${cert.sourceRepositoryURI}`);

  const trigger = cert.buildTrigger ?? cert.buildTriggerEvent;
  if (trigger !== policy.buildTrigger)
    reasons.push(`build trigger event ${trigger} != ${policy.buildTrigger}`);

  const ref = cert.sourceRepositoryRef ?? "";
  if (!new RegExp(policy.sourceRefPattern).test(ref))
    reasons.push(`source ref does not match tag pattern: ${ref}`);
  // Bind the EXACT tag ref, not merely the SemVer pattern, so an attacker who
  // relabels the certificate ref to a different valid tag is rejected by this
  // pure function and not only by the gh `--source-ref` flag.
  if (
    policy.expectedSourceRef !== undefined &&
    ref !== policy.expectedSourceRef
  )
    reasons.push(`source ref ${ref} != ${policy.expectedSourceRef}`);

  if (
    policy.denySelfHostedRunners &&
    cert.runnerEnvironment !== policy.runnerEnvironment
  )
    reasons.push(
      `runner environment ${cert.runnerEnvironment} != ${policy.runnerEnvironment}`,
    );

  const signerPrefix = `https://github.com/${policy.signerWorkflow}@`;
  if (
    typeof cert.buildSignerURI !== "string" ||
    !cert.buildSignerURI.startsWith(signerPrefix)
  )
    reasons.push(`signer workflow mismatch: ${cert.buildSignerURI}`);

  if (policy.expectedSourceDigest !== undefined) {
    if (cert.sourceRepositoryDigest !== policy.expectedSourceDigest)
      reasons.push(
        `source digest ${cert.sourceRepositoryDigest} != ${policy.expectedSourceDigest}`,
      );
  }
  if (policy.expectedSignerDigest !== undefined) {
    if (cert.buildSignerDigest !== policy.expectedSignerDigest)
      reasons.push(
        `signer digest ${cert.buildSignerDigest} != ${policy.expectedSignerDigest}`,
      );
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Compare a detached manifest to locally recomputed artifact digests. Detects
 * mix-and-match substitution (a valid archive presented with a mismatched
 * manifest) and any changed plugin file (which changes the archive digest).
 * `actual` = { bundleSha256, archiveSha256 }.
 */
export function compareManifestToArtifacts(manifest, actual) {
  const reasons = [];
  const expectBundle = manifest?.subjects?.bundle?.sha256;
  const expectArchive = manifest?.subjects?.pluginArchive?.sha256;
  if (!/^[0-9a-f]{64}$/.test(expectBundle ?? ""))
    reasons.push("manifest bundle sha256 malformed");
  if (!/^[0-9a-f]{64}$/.test(expectArchive ?? ""))
    reasons.push("manifest archive sha256 malformed");
  if (
    actual?.bundleSha256 &&
    expectBundle &&
    actual.bundleSha256 !== expectBundle
  )
    reasons.push("bundle digest does not match manifest");
  if (
    actual?.archiveSha256 &&
    expectArchive &&
    actual.archiveSha256 !== expectArchive
  )
    reasons.push("archive digest does not match manifest");
  if (!actual?.bundleSha256 && !actual?.archiveSha256)
    reasons.push("no actual digest supplied to compare");
  return { ok: reasons.length === 0, reasons };
}

/** Normalize the parsed gh output into an array of result entries. */
function resultEntries(ghJson) {
  if (Array.isArray(ghJson)) return ghJson;
  return null;
}

function evaluateOne(entry, policy) {
  const reasons = [];
  const vr = entry?.verificationResult;
  if (!vr || typeof vr !== "object") {
    return { ok: false, reasons: ["missing verificationResult"] };
  }
  const statement = vr.statement;
  if (!statement || typeof statement !== "object") {
    return { ok: false, reasons: ["missing statement"] };
  }
  if (statement.predicateType !== policy.predicateType)
    reasons.push(`predicate type mismatch: ${statement.predicateType}`);

  const subj = checkSubjectDigest(statement, policy.expectedSubjectSha256);
  reasons.push(...subj.reasons);

  const cert = vr.signature?.certificate;
  const certCheck = checkCertificateExtensions(cert, policy);
  reasons.push(...certCheck.reasons);

  // Deny compromised digests (source commit and subject).
  if (isDenied(cert?.sourceRepositoryDigest, policy.denylist))
    reasons.push("source digest is denied");
  if (isDenied(policy.expectedSubjectSha256, policy.denylist))
    reasons.push("subject digest is denied");

  return { ok: reasons.length === 0, reasons };
}

/**
 * Top-level fail-closed decision over the parsed `gh attestation verify
 * --format json` output. Returns `{ ok, reasons }`. Fails closed on a non-array
 * shape, an empty array (absent attestation), any single failing entry
 * (ambiguous/conflicting results never pass), and — when `policy.nowMs` is set
 * — on a freshness failure.
 */
export function evaluateVerification(ghJson, policy) {
  const reasons = [];
  const entries = resultEntries(ghJson);
  if (entries === null) {
    return { ok: false, reasons: ["gh output is not an array"] };
  }
  if (entries.length === 0) {
    return { ok: false, reasons: ["no attestation found for subject"] };
  }
  // Every result must satisfy the full policy: a mix of a good and a bad
  // (conflicting) attestation fails closed.
  entries.forEach((entry, index) => {
    const result = evaluateOne(entry, policy);
    if (!result.ok)
      reasons.push(...result.reasons.map((r) => `result[${index}]: ${r}`));
  });

  if (typeof policy.nowMs === "number") {
    const fresh = freshnessOk(policy, policy.nowMs);
    if (!fresh.ok) reasons.push(...fresh.reasons);
  }

  return { ok: reasons.length === 0, reasons };
}

// ---- CLI wrapper (not exercised by tests) ---------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      if (!args._) args._ = [];
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function runGh(subject, policy, tag) {
  const ghArgs = [
    "attestation",
    "verify",
    subject,
    "--repo",
    policy.repository,
    "--signer-workflow",
    policy.signerWorkflow,
    "--source-ref",
    `refs/tags/${tag}`,
    "--cert-oidc-issuer",
    policy.oidcIssuer,
    "--deny-self-hosted-runners",
    "--predicate-type",
    policy.predicateType,
    "--format",
    "json",
  ];
  if (policy.expectedSignerDigest)
    ghArgs.push("--signer-digest", policy.expectedSignerDigest);
  if (policy.expectedSourceDigest)
    ghArgs.push("--source-digest", policy.expectedSourceDigest);
  try {
    const out = execFileSync("gh", ghArgs, { encoding: "utf8" });
    if (!out || !out.trim()) return { ok: false, json: null };
    return { ok: true, json: JSON.parse(out) };
  } catch {
    // Nonzero exit, unparseable output, or gh unavailable: fail closed.
    return { ok: false, json: null };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const subject = args._?.[0] ?? args.subject;
  const tag = args.tag;
  if (!subject || !tag) {
    process.stderr.write(
      "usage: verify-provenance.mjs <subject> --tag vX.Y.Z " +
        "--source-digest <release-commit-sha> [--signer-digest <sha>] " +
        "[--policy <file>] [--denylist <file>] [--manifest <file>]\n",
    );
    process.exit(2);
  }

  let overrides = {};
  if (args.policy) overrides = JSON.parse(await readFile(args.policy, "utf8"));
  const policy = defaultPolicy(overrides);
  if (args["source-digest"])
    policy.expectedSourceDigest = args["source-digest"];
  if (args["signer-digest"])
    policy.expectedSignerDigest = args["signer-digest"];
  if (args.denylist) {
    const deny = JSON.parse(await readFile(args.denylist, "utf8"));
    policy.denylist = Array.isArray(deny) ? deny : (deny.denylist ?? []);
  }

  // ADR 0001 requires binding the exact source commit equal to the approved
  // release tag target. Fail closed if no expected source commit is supplied:
  // verifying without a pinned source digest would fail OPEN on source binding.
  if (!policy.expectedSourceDigest) {
    process.stderr.write(
      "FAILED: an expected source commit is required. Pass --source-digest " +
        "<release-commit-sha> (or set expectedSourceDigest in --policy). " +
        "Verifying without a pinned source commit is rejected.\n",
    );
    process.exit(2);
  }
  // The signer workflow digest is strongly recommended; warn prominently when
  // absent rather than silently accepting any signer workflow revision.
  if (!policy.expectedSignerDigest) {
    process.stderr.write(
      "WARNING: no signer workflow digest pinned (--signer-digest). Any " +
        "revision of the signer workflow will be accepted. Pin it for a " +
        "stronger identity binding.\n",
    );
  }

  // Bind the EXACT tag ref in the pure verifier, in addition to gh's flag.
  policy.expectedSourceRef = `refs/tags/${tag}`;
  policy.nowMs = Date.now();

  const subjectBytes = await readFile(subject);
  policy.expectedSubjectSha256 = sha256Hex(subjectBytes);

  // Optional detached-manifest mix-and-match check for the archive subject.
  if (args.manifest) {
    const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
    const cmp = compareManifestToArtifacts(manifest, {
      archiveSha256: policy.expectedSubjectSha256,
    });
    if (!cmp.ok) {
      process.stderr.write(`FAILED: ${cmp.reasons.join("; ")}\n`);
      process.exit(1);
    }
  }

  const gh = runGh(subject, policy, tag);
  if (!gh.ok) {
    process.stderr.write(
      "FAILED: gh attestation verify did not return usable output\n",
    );
    process.exit(1);
  }
  const result = evaluateVerification(gh.json, policy);
  if (!result.ok) {
    process.stderr.write(`FAILED: ${result.reasons.join("; ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`verified: ${subject} for ${tag}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`FAILED: ${error.message}\n`);
    process.exit(1);
  });
}
