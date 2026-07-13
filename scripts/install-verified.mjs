// Consumer-owned reference verified-install / managed-promotion wrapper for
// the ADR 0001 consumer-enforcement boundary (#26).
//
// IMPORTANT: this file is shipped as REFERENCE code inside the Rigor
// distribution, but it is only an enforcement boundary when a CONSUMER copies
// it (and its policy) to a location OUTSIDE the plugin tree it protects and
// runs it from there with consumer-held policy (approved versions, denylist,
// break-glass permission, offline age limits). A verifier or policy shipped
// INSIDE the distribution it verifies is not itself a boundary: the same
// unreviewed change that could compromise the plugin could also disable or
// rewrite a verifier living beside it. Only an independently held copy and
// policy break that circularity. See docs/provenance.md's "Consumer
// enforcement (#26)" section.
//
// What this wrapper does, end to end:
//   (a) recomputes the SHA-256 of the exact downloaded complete-plugin
//       archive (never trusts a checksum distributed beside it);
//   (b) verifies that digest against GitHub Artifact Attestations AND
//       independently held consumer policy, reusing every decision function
//       exported by scripts/verify-provenance.mjs (evaluateVerification,
//       compareManifestToArtifacts, the gh version/shape guards) plus the
//       detached-manifest mix-and-match check;
//   (c) confirms the pinned version+commit is in the consumer's approved set
//       and not denied (replay/freshness) via checkApproval;
//   (d) promotes ONLY verified bytes into a read-only local seed directory
//       and confirms the promoted seed re-packages (via
//       scripts/package-plugin.mjs) to the exact verified archive digest —
//       closing the verify/execute TOCTOU gap;
//   (e) instructs (or, with --launch, executes) Claude Code with
//       `claude --plugin-dir <seed>` so the session loads the exact tree that
//       was verified. `claude --plugin-dir <path>` was experimentally
//       confirmed to exist in Claude Code 2.1.207 (a session-scoped explicit
//       load); the ordinary marketplace install/update flow has no confirmed
//       pre-activation verification hook over its cache, so this wrapper does
//       not and cannot protect an ordinary marketplace install;
//   (f) refuses to promote and exits non-zero on ANY verification, approval,
//       freshness, or seed-integrity failure, and never prints "verified" on
//       failure.
//
// ALL trust decisions live in the exported pure functions below (no I/O,
// clock, or network in the decision path — every timestamp is an explicit
// `nowMs` parameter). Process spawning (tar extraction, chmod, gh, launching
// Claude Code), filesystem promotion, and stdout live ONLY in the thin
// main() wrapper, guarded by an import.meta.url main check, and main() is NOT
// exercised by tests.
//
// The audit receipt main() writes after a decision is an OUTPUT, explicitly
// not a trust root: this wrapper re-verifies from scratch on every run and
// never reads a previously written receipt to decide trust.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

import {
  defaultPolicy,
  evaluateVerification,
  compareManifestToArtifacts,
  sha256Hex,
  freshnessOk,
  isDenied,
  validateGhShape,
  parseGhVersion,
  isSupportedGhVersion,
  getGhVersionRaw,
  runGh,
} from "./verify-provenance.mjs";
import { collectPluginFiles, buildArchive } from "./package-plugin.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_BREAK_GLASS_MAX_LIFETIME_MS = 72 * HOUR_MS;
const HEX64_RE = /^[0-9a-f]{64}$/i;
const HEX40_RE = /^[0-9a-f]{40}$/i;

// ---- pure decision functions ------------------------------------------------

/**
 * Is `version`/`commit` in the consumer's approved set and not denied?
 * `policy.approvedVersions` is either a map `{ version: commit }` or an array
 * of `{ version, commit }` records. `policy.denylist` (shared with
 * verify-provenance's digest denylist) may also carry denied version strings
 * or commit SHAs. Fails closed: a missing/empty version or commit, a version
 * absent from the approved set, a commit that does not match the approved
 * commit for that version, or a denied version/commit are all `ok: false`.
 * This is how a replayed old or unlisted version, or an explicitly denied
 * one, is rejected rather than silently accepted.
 */
export function checkApproval(version, commit, policy) {
  const reasons = [];
  if (typeof version !== "string" || version.length === 0) {
    reasons.push("version is missing");
  }
  if (typeof commit !== "string" || !HEX40_RE.test(commit)) {
    reasons.push("commit is missing or not 40-hex");
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const approved = policy?.approvedVersions;
  let approvedCommit;
  if (Array.isArray(approved)) {
    approvedCommit = approved.find(
      (entry) => entry && entry.version === version,
    )?.commit;
  } else if (approved && typeof approved === "object") {
    approvedCommit = approved[version];
  }
  if (typeof approvedCommit !== "string" || approvedCommit.length === 0) {
    reasons.push(`version ${version} is not in the approved set`);
  } else if (approvedCommit.toLowerCase() !== commit.toLowerCase()) {
    reasons.push(
      `approved commit for ${version} does not match the presented commit`,
    );
  }

  // Reuse verify-provenance's isDenied so version/commit denial shares the
  // exact same fail-closed, case-insensitive comparison as digest denial; the
  // consumer-maintained denylist may carry version strings and commit SHAs
  // alongside subject/source digests.
  const denylist = Array.isArray(policy?.denylist) ? policy.denylist : [];
  if (isDenied(version, denylist)) reasons.push(`version ${version} is denied`);
  if (isDenied(commit, denylist)) reasons.push(`commit ${commit} is denied`);

  return { ok: reasons.length === 0, reasons };
}

/**
 * Validate a break-glass record: an explicit, human-approved, time-bounded
 * exception used ONLY when verification is impossible or failed. Requires a
 * non-empty `record.approver` (an independent human, not the wrapper or the
 * release itself), a numeric `record.expiresAtMs` strictly in the future of
 * `nowMs`, a bounded lifetime (`expiresAtMs - issuedAtMs` at most
 * `maxLifetimeMs`, default 72h), and `record.verified === false` — a
 * break-glass activation must never claim to be verified. Fails closed on
 * anything missing, expired, without an approver, over the maximum lifetime,
 * or that claims `verified` truthy.
 */
export function validateBreakGlass(
  record,
  nowMs,
  maxLifetimeMs = DEFAULT_BREAK_GLASS_MAX_LIFETIME_MS,
) {
  if (!record || typeof record !== "object") {
    return { ok: false, reasons: ["break-glass record is missing"] };
  }
  const reasons = [];
  if (
    typeof record.approver !== "string" ||
    record.approver.trim().length === 0
  ) {
    reasons.push("break-glass record has no independent human approver");
  }
  if (
    typeof record.expiresAtMs !== "number" ||
    Number.isNaN(record.expiresAtMs)
  ) {
    reasons.push("break-glass record has no expiresAtMs");
  } else if (nowMs >= record.expiresAtMs) {
    reasons.push("break-glass record has expired");
  }
  if (
    typeof record.issuedAtMs !== "number" ||
    Number.isNaN(record.issuedAtMs)
  ) {
    reasons.push("break-glass record has no issuedAtMs");
  } else if (
    typeof record.expiresAtMs === "number" &&
    record.expiresAtMs - record.issuedAtMs > maxLifetimeMs
  ) {
    reasons.push("break-glass lifetime exceeds the maximum allowed");
  }
  if (record.verified !== false) {
    reasons.push("break-glass record must explicitly declare verified: false");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Confirms the promoted local seed re-packages to EXACTLY the verified
 * archive digest (closing the TOCTOU gap between what was verified and what
 * will execute). Both digests must be present, 64-hex, and equal; anything
 * missing, malformed, or mismatched fails closed.
 */
export function checkSeedIntegrity(
  promotedArchiveSha256,
  verifiedArchiveSha256,
) {
  const reasons = [];
  if (!HEX64_RE.test(promotedArchiveSha256 ?? ""))
    reasons.push("promoted archive sha256 is missing or not 64-hex");
  if (!HEX64_RE.test(verifiedArchiveSha256 ?? ""))
    reasons.push("verified archive sha256 is missing or not 64-hex");
  if (
    reasons.length === 0 &&
    promotedArchiveSha256.toLowerCase() !== verifiedArchiveSha256.toLowerCase()
  ) {
    reasons.push(
      "promoted seed does not re-package to the verified archive digest",
    );
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Deterministic, order-safe install decision. Returns
 * `{ action: "promote" | "keep-pinned" | "break-glass" | "refuse", reasons }`.
 *
 * - `promote`: only when `verify.ok && approval.ok && seedIntegrity.ok`, and
 *   (when `offline` is true) `freshness.ok` — an online promotion of newly
 *   verified bytes does not additionally require the offline freshness
 *   window.
 * - `break-glass`: only when verification itself is impossible/failed
 *   (`!verify.ok`) — never when verification passed but approval or seed
 *   integrity failed — AND `policy.allowBreakGlass === true` AND a supplied
 *   `breakGlass` record passes `validateBreakGlass`. Never reported as
 *   verified.
 * - `keep-pinned`: only when offline, verification of a NEW version was not
 *   possible (`!verify.ok`), `policy.allowOfflineLastKnownGood === true`, and
 *   the existing pinned version's `approval.ok`/`freshness.ok` both hold —
 *   the documented offline last-known-good path. It never promotes new or
 *   unverified bytes.
 * - `refuse`: every other case — a replayed/denied version, staleness beyond
 *   the max age with no valid exception, a missing/invalid attestation, or a
 *   seed-integrity mismatch. Fail-closed is the default: a failing `verify`
 *   with no valid break-glass or keep-pinned exception always refuses.
 */
export function decideInstall({
  verify,
  approval,
  freshness,
  seedIntegrity,
  offline,
  breakGlass,
  policy,
  nowMs,
}) {
  const p = policy ?? {};

  if (
    verify?.ok === true &&
    approval?.ok === true &&
    seedIntegrity?.ok === true &&
    (offline === true ? freshness?.ok === true : true)
  ) {
    return {
      action: "promote",
      reasons: ["verification, approval, and seed integrity all passed"],
    };
  }

  const reasons = [];

  // Break-glass is eligible ONLY when verification itself is impossible or
  // failed -- an approval or seed-integrity failure on an otherwise verified
  // artifact must refuse, not fall through to break-glass.
  if (verify?.ok !== true && p.allowBreakGlass === true && breakGlass) {
    const bg = validateBreakGlass(breakGlass, nowMs, p.breakGlassMaxLifetimeMs);
    if (bg.ok) {
      return {
        action: "break-glass",
        reasons: ["break-glass approved by an independent human; NOT verified"],
      };
    }
    reasons.push(...bg.reasons.map((r) => `break-glass: ${r}`));
  }

  // Offline last-known-good: continue an ALREADY verified pinned version
  // rather than promote anything new.
  if (
    offline === true &&
    verify?.ok !== true &&
    p.allowOfflineLastKnownGood === true &&
    approval?.ok === true &&
    freshness?.ok === true
  ) {
    return {
      action: "keep-pinned",
      reasons: [
        "offline last-known-good: continuing an already-verified pinned version within max age",
      ],
    };
  }

  if (verify?.ok !== true)
    reasons.push(
      ...(verify?.reasons ?? ["verification failed or was not attempted"]),
    );
  if (approval?.ok !== true)
    reasons.push(...(approval?.reasons ?? ["approval check failed"]));
  if (seedIntegrity?.ok !== true)
    reasons.push(
      ...(seedIntegrity?.reasons ?? ["seed-integrity check failed"]),
    );
  if (offline === true && freshness?.ok !== true)
    reasons.push(...(freshness?.reasons ?? ["freshness check failed"]));
  if (reasons.length === 0)
    reasons.push("verification, approval, and seed integrity did not all pass");

  return { action: "refuse", reasons };
}

// ---- CLI wrapper (not exercised by tests) ----------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
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

async function loadJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function removeQuietly(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version;
  const commit = args.commit;
  const archivePath = args.archive;
  const seedDir = args.seed;
  if (!version || !commit || !archivePath || !seedDir) {
    process.stderr.write(
      "usage: install-verified.mjs --version X.Y.Z --commit <sha> " +
        "--archive <rigor-X.Y.Z.tar.gz> --seed <dir> [--policy <file>] " +
        "[--denylist <file>] [--manifest <file>] [--offline] " +
        "[--break-glass <file>] [--launch] [--source-digest <sha>] " +
        "[--signer-digest <sha>]\n",
    );
    process.exit(2);
  }

  let overrides = {};
  if (args.policy) overrides = await loadJson(args.policy);
  const policy = defaultPolicy(overrides);
  if (args["source-digest"])
    policy.expectedSourceDigest = args["source-digest"];
  if (args["signer-digest"])
    policy.expectedSignerDigest = args["signer-digest"];
  if (args.denylist) {
    const deny = await loadJson(args.denylist);
    policy.denylist = Array.isArray(deny) ? deny : (deny.denylist ?? []);
  }

  const offline = args.offline === true;
  const nowMs = Date.now();
  policy.nowMs = nowMs;
  policy.expectedSourceRef = `refs/tags/v${version}`;

  const archiveBytes = await readFile(archivePath);
  const archiveSha256 = sha256Hex(archiveBytes);
  policy.expectedSubjectSha256 = archiveSha256;

  const manifestReasons = [];
  if (args.manifest) {
    const manifest = await loadJson(args.manifest);
    const cmp = compareManifestToArtifacts(manifest, { archiveSha256 });
    if (!cmp.ok) manifestReasons.push(...cmp.reasons);
  }

  let verify;
  let observedGhVersion = null;
  if (offline) {
    verify = {
      ok: false,
      reasons: [
        ...manifestReasons,
        "--offline: attestation verification was not attempted",
      ],
    };
  } else {
    const ghVersionRaw = getGhVersionRaw();
    const ghVersion = ghVersionRaw ? parseGhVersion(ghVersionRaw) : null;
    if (!ghVersionRaw) {
      verify = {
        ok: false,
        reasons: [...manifestReasons, "gh CLI is not available"],
      };
    } else if (!ghVersion) {
      verify = {
        ok: false,
        reasons: [
          ...manifestReasons,
          `could not parse gh --version output: ${ghVersionRaw.trim()}`,
        ],
      };
    } else if (!isSupportedGhVersion(ghVersion, policy)) {
      verify = {
        ok: false,
        reasons: [
          ...manifestReasons,
          `unsupported gh CLI version ${ghVersion.major}.${ghVersion.minor}.${ghVersion.patch}`,
        ],
      };
    } else {
      observedGhVersion = `${ghVersion.major}.${ghVersion.minor}.${ghVersion.patch}`;
      const gh = runGh(archivePath, policy, `v${version}`);
      if (!gh.ok) {
        verify = {
          ok: false,
          reasons: [
            ...manifestReasons,
            "gh attestation verify did not return usable output",
          ],
        };
      } else {
        const shape = validateGhShape(gh.json);
        if (!shape.ok) {
          verify = {
            ok: false,
            reasons: [...manifestReasons, ...shape.reasons],
          };
        } else {
          const result = evaluateVerification(gh.json, policy);
          verify = {
            ok: result.ok && manifestReasons.length === 0,
            reasons: [...manifestReasons, ...result.reasons],
          };
        }
      }
    }
  }

  const approval = checkApproval(version, commit, policy);
  const freshness = freshnessOk(policy, nowMs);

  let breakGlass;
  if (args["break-glass"]) breakGlass = await loadJson(args["break-glass"]);

  // First decision pass: seed integrity is provisionally unknown/ok because
  // the seed has not been written yet. A real seed-integrity check follows
  // AFTER extraction below and can still override "promote"/"break-glass"
  // into a refusal if the promoted bytes do not match.
  const decision = decideInstall({
    verify,
    approval,
    freshness,
    seedIntegrity: { ok: true, reasons: [] },
    offline,
    breakGlass,
    policy,
    nowMs,
  });

  const receiptPath =
    args.receipt ?? `${seedDir.replace(/\/+$/, "")}.receipt.json`;
  const writeReceipt = async (fields) => {
    const receipt = {
      schemaVersion: "rigor.install-verified.receipt.v1",
      note:
        "This receipt is an audit OUTPUT, not a trust root. This wrapper " +
        "never reads a receipt to decide trust; every run re-verifies from " +
        "scratch.",
      version,
      commit,
      archiveSha256,
      ghVersion: observedGhVersion,
      timestamp: new Date(nowMs).toISOString(),
      ...fields,
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  };

  if (decision.action === "refuse") {
    await writeReceipt({
      action: "refuse",
      verified: false,
      reasons: decision.reasons,
    });
    process.stderr.write(`FAILED: ${decision.reasons.join("; ")}\n`);
    process.exit(1);
    return;
  }

  if (decision.action === "keep-pinned") {
    await writeReceipt({
      action: "keep-pinned",
      verified: true,
      reasons: decision.reasons,
    });
    process.stdout.write(
      "keep-pinned: continuing the existing verified pinned seed (offline last-known-good).\n",
    );
    process.stdout.write(`claude --plugin-dir ${seedDir}\n`);
    if (args.launch) {
      execFileSync("claude", ["--plugin-dir", seedDir], { stdio: "inherit" });
    }
    return;
  }

  // decision.action is "promote" or "break-glass": extract the exact archive
  // bytes into a fresh seed directory, lock it read-only, and re-package it
  // to confirm no extraction step altered the tree (TOCTOU close).
  await removeQuietly(seedDir);
  await mkdir(seedDir, { recursive: true });
  try {
    execFileSync("tar", [
      "-xzf",
      path.resolve(archivePath),
      "-C",
      seedDir,
      "--strip-components=1",
    ]);
  } catch (error) {
    await removeQuietly(seedDir);
    await writeReceipt({
      action: "refuse",
      verified: false,
      reasons: [`archive extraction failed: ${error.message}`],
    });
    process.stderr.write(
      `FAILED: archive extraction failed: ${error.message}\n`,
    );
    process.exit(1);
    return;
  }

  const entries = await collectPluginFiles(seedDir);
  const repackaged = buildArchive(version, entries);
  const repackagedSha256 = sha256Hex(repackaged.archive);
  const seedIntegrity = checkSeedIntegrity(repackagedSha256, archiveSha256);

  if (!seedIntegrity.ok) {
    await removeQuietly(seedDir);
    await writeReceipt({
      action: "refuse",
      verified: false,
      reasons: seedIntegrity.reasons,
    });
    process.stderr.write(`FAILED: ${seedIntegrity.reasons.join("; ")}\n`);
    process.exit(1);
    return;
  }

  // Best-effort: make the promoted seed read-only so a later, separately
  // fetched copy cannot silently mutate the bytes just verified.
  try {
    execFileSync("chmod", ["-R", "a-w", seedDir]);
  } catch {
    // Non-fatal: seed-integrity re-packaging above already confirmed the
    // promoted bytes, and the seed remains inspectable even if chmod fails.
  }

  const verified = decision.action === "promote";
  await writeReceipt({
    action: decision.action,
    verified,
    reasons: decision.reasons,
    seed: { path: seedDir, repackagedSha256 },
  });

  if (decision.action === "break-glass") {
    process.stderr.write(
      "BREAK-GLASS (NOT verified): promoting unverified bytes under an " +
        "independently human-approved, time-bounded exception.\n",
    );
  } else {
    process.stdout.write(`verified: ${archivePath} for v${version}\n`);
  }
  process.stdout.write(`claude --plugin-dir ${seedDir}\n`);
  if (args.launch) {
    execFileSync("claude", ["--plugin-dir", seedDir], { stdio: "inherit" });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`FAILED: ${error.message}\n`);
    process.exit(1);
  });
}
