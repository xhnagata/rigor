import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The implementation lives in pure-Node .mjs scripts (not compiled by tsc).
// Import them through a non-literal specifier so the type checker treats the
// modules structurally via the interfaces below rather than demanding a
// declaration file, while tsx resolves them normally at runtime.
interface StagedEntry {
  name: string;
  mode: number;
  content: Buffer;
}
interface TarEntry {
  name: string;
  mode: number;
  type: string;
  content?: Buffer;
}
interface BuiltArchive {
  archive: Buffer;
  tarName: string;
  topDir: string;
}
interface CheckResult {
  ok: boolean;
  reasons: string[];
}
interface PackageModule {
  PLUGIN_FILES: string[];
  collectPluginFiles(root: string): Promise<StagedEntry[]>;
  buildArchive(version: string, entries: StagedEntry[]): BuiltArchive;
  buildTar(entries: TarEntry[]): Buffer;
  normalizeGzip(buf: Buffer): Buffer;
  buildManifest(fields: Record<string, unknown>): Record<string, unknown>;
  validateManifest(manifest: unknown): CheckResult;
  canonicalJson(value: unknown): string;
  sha256Hex(buf: Buffer): string;
}
interface GhVersion {
  major: number;
  minor: number;
  patch: number;
}
interface VerifyModule {
  defaultPolicy(overrides?: Record<string, unknown>): Record<string, unknown>;
  evaluateVerification(
    ghJson: unknown,
    policy: Record<string, unknown>,
  ): CheckResult;
  checkCertificateExtensions(
    cert: unknown,
    policy: Record<string, unknown>,
  ): CheckResult;
  checkSubjectDigest(statement: unknown, expected: string): CheckResult;
  compareManifestToArtifacts(
    manifest: unknown,
    actual: Record<string, unknown>,
  ): CheckResult;
  isDenied(digest: unknown, denylist: unknown[]): boolean;
  freshnessOk(policy: Record<string, unknown>, nowMs: number): CheckResult;
  sha256Hex(buf: Buffer): string;
  parseGhVersion(str: unknown): GhVersion | null;
  isSupportedGhVersion(
    parsed: GhVersion | null,
    policy: Record<string, unknown>,
  ): boolean;
  validateGhShape(ghJson: unknown): CheckResult;
}
interface InstallDecisionInput {
  verify: CheckResult;
  approval: CheckResult;
  freshness: CheckResult;
  seedIntegrity: CheckResult;
  offline: boolean;
  breakGlass?: Record<string, unknown>;
  policy: Record<string, unknown>;
  nowMs: number;
}
interface InstallDecision {
  action: "promote" | "keep-pinned" | "break-glass" | "refuse";
  reasons: string[];
}
interface InstallModule {
  checkApproval(
    version: unknown,
    commit: unknown,
    policy: Record<string, unknown>,
  ): CheckResult;
  validateBreakGlass(
    record: unknown,
    nowMs: number,
    maxLifetimeMs?: number,
  ): CheckResult;
  checkSeedIntegrity(promoted: unknown, verified: unknown): CheckResult;
  decideInstall(input: InstallDecisionInput): InstallDecision;
}

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pkgSpecifier = "../scripts/package-plugin.mjs";
const verifySpecifier = "../scripts/verify-provenance.mjs";
const installSpecifier = "../scripts/install-verified.mjs";
const pkg = (await import(pkgSpecifier)) as unknown as PackageModule;
const verify = (await import(verifySpecifier)) as unknown as VerifyModule;
const install = (await import(installSpecifier)) as unknown as InstallModule;

async function pluginVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(rootDir, ".claude-plugin/plugin.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
}

function octal(buf: Buffer): number {
  return parseInt(buf.toString("ascii").replace(/\0.*$/, "").trim(), 8);
}

interface TarRecord {
  name: string;
  mode: number;
  size: number;
  mtime: number;
  type: string;
}

// Minimal ustar reader: enough to inspect the produced archive.
function parseTar(tar: Buffer): TarRecord[] {
  const records: TarRecord[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("ascii").replace(/\0.*$/, "");
    const mode = octal(header.subarray(100, 108));
    const size = octal(header.subarray(124, 136));
    const mtime = octal(header.subarray(136, 148));
    const type = header.subarray(156, 157).toString("ascii");
    records.push({ name, mode, size, mtime, type });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return records;
}

test("packaging is byte-deterministic across two builds", async () => {
  const version = await pluginVersion();
  const first = pkg.buildArchive(
    version,
    await pkg.collectPluginFiles(rootDir),
  );
  const second = pkg.buildArchive(
    version,
    await pkg.collectPluginFiles(rootDir),
  );
  assert.equal(pkg.sha256Hex(first.archive), pkg.sha256Hex(second.archive));
  assert.equal(first.tarName, `rigor-${version}.tar.gz`);
});

test("gzip header is normalized (no mtime, OS byte 0xFF)", async () => {
  const version = await pluginVersion();
  const { archive } = pkg.buildArchive(
    version,
    await pkg.collectPluginFiles(rootDir),
  );
  assert.equal(archive[0], 0x1f);
  assert.equal(archive[1], 0x8b);
  for (const i of [4, 5, 6, 7]) assert.equal(archive[i], 0, `mtime byte ${i}`);
  assert.equal(archive[9], 0xff, "OS byte");
});

test("archive contains exactly the 21 files plus one top directory", async () => {
  const version = await pluginVersion();
  const { archive, topDir } = pkg.buildArchive(
    version,
    await pkg.collectPluginFiles(rootDir),
  );
  const records = parseTar(gunzipSync(archive));

  const dirs = records.filter((r) => r.type === "5");
  const files = records.filter((r) => r.type === "0");
  assert.equal(dirs.length, 1, "exactly one directory entry");
  assert.equal(dirs[0]?.name, `${topDir}/`);
  assert.equal(dirs[0]?.mode & 0o777, 0o755);
  assert.equal(files.length, pkg.PLUGIN_FILES.length);
  assert.equal(files.length, 21);

  const expected = pkg.PLUGIN_FILES.map((f) => `${topDir}/${f}`).sort();
  const actualNames = files.map((f) => f.name);
  assert.deepEqual([...actualNames].sort(), expected);

  // Entries are emitted in bytewise (LC_ALL=C) sorted order.
  const allNames = records.map((r) => r.name);
  const bytewise = [...allNames].sort((a, b) =>
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
  );
  assert.deepEqual(allNames, bytewise);

  for (const record of records) {
    assert.equal(record.mtime, 0, `${record.name} mtime must be 0`);
    if (record.type === "0") {
      const expectedMode = record.name.endsWith("/bin/rigor") ? 0o755 : 0o644;
      assert.equal(record.mode & 0o777, expectedMode, `${record.name} mode`);
    }
  }
});

test("collectPluginFiles rejects an unexpected file under a packaged root", async () => {
  // Point at a scratch root missing the plugin tree: collection must fail
  // closed rather than package a partial set.
  await assert.rejects(() => pkg.collectPluginFiles("/nonexistent-root-xyz"));
});

// ---- manifest + schema ----------------------------------------------------

interface JsonSchema {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
}

// Tiny hand-rolled validator for the subset of JSON Schema our schema uses
// (the repo has no ajv). Cross-field equalities are enforced by
// pkg.validateManifest, exercised alongside this.
function schemaErrors(
  schema: JsonSchema,
  value: unknown,
  where = "$",
): string[] {
  const errs: string[] = [];
  if ("const" in schema && value !== schema.const)
    errs.push(`${where} !== const`);
  if (schema.enum && !schema.enum.includes(value))
    errs.push(`${where} not in enum`);
  if (schema.type) {
    const t = schema.type;
    const typeOk =
      t === "object"
        ? typeof value === "object" && value !== null && !Array.isArray(value)
        : t === "array"
          ? Array.isArray(value)
          : typeof value === t;
    if (!typeOk) {
      errs.push(`${where} wrong type`);
      return errs;
    }
  }
  if (schema.type === "string" && typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      errs.push(`${where} pattern`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      errs.push(`${where} minLength`);
  }
  if (
    schema.type === "object" &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const props = schema.properties ?? {};
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? [])
      if (!(req in obj)) errs.push(`${where}.${req} required`);
    for (const key of Object.keys(obj)) {
      const sub = props[key];
      if (sub) errs.push(...schemaErrors(sub, obj[key], `${where}.${key}`));
      else if (schema.additionalProperties === false)
        errs.push(`${where}.${key} additional`);
    }
  }
  return errs;
}

async function loadSchema(): Promise<JsonSchema> {
  return JSON.parse(
    await readFile(
      path.join(rootDir, "schemas/release-manifest.v1.schema.json"),
      "utf8",
    ),
  ) as JsonSchema;
}

function validManifest(): Record<string, unknown> {
  return pkg.buildManifest({
    version: "0.11.0",
    tag: "v0.11.0",
    commit: "c".repeat(40),
    sourceRef: "refs/tags/v0.11.0",
    workflowRef:
      "xhnagata/rigor/.github/workflows/release.yml@refs/tags/v0.11.0",
    workflowDigest: "c".repeat(40),
    bundleSha256: "a".repeat(64),
    archiveSha256: "b".repeat(64),
    nodeVersion: "22.11.0",
    archiveName: "rigor-0.11.0.tar.gz",
  });
}

test("a well-formed manifest passes the schema and cross-field validation", async () => {
  const schema = await loadSchema();
  const manifest = validManifest();
  assert.deepEqual(schemaErrors(schema, manifest), []);
  assert.equal(pkg.validateManifest(manifest).ok, true);
});

test("the built manifest never records its own digest", () => {
  const manifest = validManifest();
  const json = pkg.canonicalJson(manifest);
  assert.ok(!json.includes("release-manifest.json"));
  assert.ok(!json.includes("releaseManifest"));
});

test("manifest negatives fail schema and/or cross-field validation", async () => {
  const schema = await loadSchema();
  const invalid = (mutate: (m: Record<string, unknown>) => void): boolean => {
    const m = structuredClone(validManifest());
    mutate(m);
    return schemaErrors(schema, m).length > 0 || !pkg.validateManifest(m).ok;
  };

  assert.ok(
    invalid((m) => {
      (m.source as Record<string, unknown>).repositoryId = "999";
    }),
    "wrong repositoryId",
  );
  assert.ok(
    invalid((m) => {
      (m.release as Record<string, unknown>).tag = "v9.9.9";
    }),
    "tag != v+version",
  );
  assert.ok(
    invalid((m) => {
      (m.subjects as { bundle: Record<string, unknown> }).bundle.sha256 =
        "not-hex";
    }),
    "bundle sha not 64-hex",
  );
  assert.ok(
    invalid((m) => {
      (m.subjects as { bundle: Record<string, unknown> }).bundle.path =
        "dist/other.cjs";
    }),
    "wrong bundle.path",
  );
});

// ---- verifier decision logic ----------------------------------------------

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(rootDir, "test/fixtures/provenance", name),
      "utf8",
    ),
  ) as unknown;
}

function basePolicy(): Record<string, unknown> {
  return verify.defaultPolicy({
    expectedSubjectSha256: "a".repeat(64),
    expectedSourceDigest: "c".repeat(40),
    expectedSignerDigest: "c".repeat(40),
  });
}

test("POSITIVE: a matching attestation verifies", async () => {
  const gh = await fixture("positive.json");
  const result = verify.evaluateVerification(gh, basePolicy());
  assert.equal(result.ok, true, result.reasons.join("; "));
});

test("NEGATIVE: changed bundle bytes (subject digest mismatch)", async () => {
  const gh = await fixture("positive.json");
  const policy = basePolicy();
  policy.expectedSubjectSha256 = "b".repeat(64);
  assert.equal(verify.evaluateVerification(gh, policy).ok, false);
});

test("NEGATIVE: wrong source SHA (cert source digest mismatch)", async () => {
  const gh = await fixture("positive.json");
  const policy = basePolicy();
  policy.expectedSourceDigest = "d".repeat(40);
  assert.equal(verify.evaluateVerification(gh, policy).ok, false);
});

test("NEGATIVE: wrong signer workflow", async () => {
  const gh = structuredClone(await fixture("positive.json")) as Array<
    Record<string, Record<string, Record<string, Record<string, unknown>>>>
  >;
  gh[0]!.verificationResult!.signature!.certificate!.buildSignerURI =
    "https://github.com/attacker/evil/.github/workflows/release.yml@refs/tags/v0.11.0";
  assert.equal(verify.evaluateVerification(gh, basePolicy()).ok, false);
});

test("NEGATIVE: wrong predicate type", async () => {
  const gh = structuredClone(await fixture("positive.json")) as Array<
    Record<string, Record<string, Record<string, unknown>>>
  >;
  gh[0]!.verificationResult!.statement!.predicateType =
    "https://slsa.dev/provenance/v0.2";
  assert.equal(verify.evaluateVerification(gh, basePolicy()).ok, false);
});

test("NEGATIVE: absent attestation (empty array / gh nonzero)", async () => {
  const gh = await fixture("empty.json");
  assert.equal(verify.evaluateVerification(gh, basePolicy()).ok, false);
});

test("NEGATIVE: self-hosted runner is denied", async () => {
  const gh = structuredClone(await fixture("positive.json")) as Array<
    Record<string, Record<string, Record<string, Record<string, unknown>>>>
  >;
  gh[0]!.verificationResult!.signature!.certificate!.runnerEnvironment =
    "self-hosted";
  assert.equal(verify.evaluateVerification(gh, basePolicy()).ok, false);
});

test("NEGATIVE: wrong numeric repository id", async () => {
  const gh = structuredClone(await fixture("positive.json")) as Array<
    Record<string, Record<string, Record<string, Record<string, unknown>>>>
  >;
  gh[0]!.verificationResult!.signature!.certificate!.sourceRepositoryID =
    "999999";
  gh[0]!.verificationResult!.signature!.certificate!.extensions = {
    "1.3.6.1.4.1.57264.1.14": "999999",
  };
  assert.equal(verify.evaluateVerification(gh, basePolicy()).ok, false);
});

test("NEGATIVE: non-array gh output fails closed", () => {
  assert.equal(
    verify.evaluateVerification({ not: "array" }, basePolicy()).ok,
    false,
  );
});

test("NEGATIVE: mixed good+conflicting results fail closed", async () => {
  const good = (await fixture("positive.json")) as unknown[];
  const bad = structuredClone(good) as Array<
    Record<string, Record<string, Record<string, Record<string, unknown>>>>
  >;
  bad[0]!.verificationResult!.signature!.certificate!.runnerEnvironment =
    "self-hosted";
  const mixed = [...good, ...bad];
  assert.equal(verify.evaluateVerification(mixed, basePolicy()).ok, false);
});

test("NEGATIVE: denied source digest fails closed", async () => {
  const gh = await fixture("positive.json");
  const policy = basePolicy();
  policy.denylist = ["c".repeat(40)];
  const result = verify.evaluateVerification(gh, policy);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("denied")));
});

test("compareManifestToArtifacts: matching digests pass", () => {
  const manifest = validManifest();
  const result = verify.compareManifestToArtifacts(manifest, {
    bundleSha256: "a".repeat(64),
    archiveSha256: "b".repeat(64),
  });
  assert.equal(result.ok, true, result.reasons.join("; "));
});

test("NEGATIVE: changed non-bundle plugin file (archive digest mismatch)", () => {
  const manifest = validManifest();
  // A changed plugin file changes the archive digest recomputed locally.
  const result = verify.compareManifestToArtifacts(manifest, {
    archiveSha256: "f".repeat(64),
  });
  assert.equal(result.ok, false);
});

test("NEGATIVE: mismatched detached manifest (mix-and-match)", () => {
  const manifest = validManifest();
  // A valid archive presented with a manifest whose archive sha differs.
  const result = verify.compareManifestToArtifacts(manifest, {
    bundleSha256: "a".repeat(64),
    archiveSha256: "e".repeat(64),
  });
  assert.equal(result.ok, false);
});

test("isDenied fails closed on empty/denied digests", () => {
  assert.equal(verify.isDenied("c".repeat(40), ["c".repeat(40)]), true);
  assert.equal(verify.isDenied("c".repeat(40), []), false);
  assert.equal(verify.isDenied("", ["x"]), true);
  assert.equal(verify.isDenied(undefined, []), true);
});

test("freshnessOk enforces trusted-root and offline max age, fails closed", () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  assert.equal(
    verify.freshnessOk(
      {
        trustedRootMaxAgeDays: 7,
        offlineMaxAgeDays: 30,
        trustedRootFetchedAtMs: now - day,
        offlineBundleFetchedAtMs: now - day,
      },
      now,
    ).ok,
    true,
  );
  // Missing root timestamp -> unknown freshness -> fail closed.
  assert.equal(verify.freshnessOk({ offlineMaxAgeDays: 30 }, now).ok, false);
  // Root older than 7 days.
  assert.equal(
    verify.freshnessOk(
      { trustedRootFetchedAtMs: now - 8 * day, trustedRootMaxAgeDays: 7 },
      now,
    ).ok,
    false,
  );
  // Offline bundle older than 30 days.
  assert.equal(
    verify.freshnessOk(
      {
        trustedRootFetchedAtMs: now - day,
        offlineBundleFetchedAtMs: now - 31 * day,
        trustedRootMaxAgeDays: 7,
        offlineMaxAgeDays: 30,
      },
      now,
    ).ok,
    false,
  );
});

test("evaluateVerification applies freshness when nowMs is set", async () => {
  const gh = await fixture("positive.json");
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const policy = basePolicy();
  policy.nowMs = now;
  policy.trustedRootFetchedAtMs = now - 8 * day; // stale root
  const result = verify.evaluateVerification(gh, policy);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("trusted root")));
});

test("checkSubjectDigest and checkCertificateExtensions unit checks", async () => {
  const gh = (await fixture("positive.json")) as Array<
    Record<string, Record<string, Record<string, unknown>>>
  >;
  const statement = gh[0]!.verificationResult!.statement;
  assert.equal(verify.checkSubjectDigest(statement, "a".repeat(64)).ok, true);
  assert.equal(verify.checkSubjectDigest(statement, "b".repeat(64)).ok, false);

  const cert = (gh[0]!.verificationResult!.signature as Record<string, unknown>)
    .certificate;
  assert.equal(verify.checkCertificateExtensions(cert, basePolicy()).ok, true);
});

type GhResults = Array<
  Record<string, Record<string, Record<string, Record<string, unknown>>>>
>;

test("expectedSourceRef binds the exact tag (matching ref still passes)", async () => {
  const gh = await fixture("positive.json");
  const policy = basePolicy();
  policy.expectedSourceRef = "refs/tags/v0.11.0";
  assert.equal(verify.evaluateVerification(gh, policy).ok, true);
});

test("NEGATIVE: a different VALID tag ref is rejected when expectedSourceRef is set", async () => {
  const gh = structuredClone(await fixture("positive.json")) as GhResults;
  // A different tag that still satisfies the SemVer pattern; the exact-ref
  // binding must reject it in the pure function, not only the gh flag.
  gh[0]!.verificationResult!.signature!.certificate!.sourceRepositoryRef =
    "refs/tags/v9.9.9";
  const policy = basePolicy();
  policy.expectedSourceRef = "refs/tags/v0.11.0";

  const cert = gh[0]!.verificationResult!.signature!.certificate;
  const certResult = verify.checkCertificateExtensions(cert, policy);
  assert.equal(certResult.ok, false);
  assert.ok(certResult.reasons.some((r) => r.includes("v9.9.9")));
  assert.equal(verify.evaluateVerification(gh, policy).ok, false);
});

test("numeric sourceRepositoryID is accepted (normalized compare)", async () => {
  const gh = structuredClone(await fixture("positive.json")) as GhResults;
  // Some gh builds may emit the id as a JSON number rather than a string.
  gh[0]!.verificationResult!.signature!.certificate!.sourceRepositoryID =
    1296432215 as unknown as string;
  delete gh[0]!.verificationResult!.signature!.certificate!.extensions;
  const cert = gh[0]!.verificationResult!.signature!.certificate;
  assert.equal(verify.checkCertificateExtensions(cert, basePolicy()).ok, true);
  assert.equal(verify.evaluateVerification(gh, basePolicy()).ok, true);
});

test("NEGATIVE: cert source digest differing from expected fails (explicit)", async () => {
  const gh = (await fixture("positive.json")) as GhResults;
  const cert = gh[0]!.verificationResult!.signature!.certificate;
  const policy = basePolicy();
  policy.expectedSourceDigest = "d".repeat(40); // cert carries "c".repeat(40)
  const result = verify.checkCertificateExtensions(cert, policy);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("source digest")));
});

// ---- real gh 2.96.0 fixture (v0.13.0) --------------------------------------

const REAL_SUBJECT_SHA256 =
  "8b3c17a3d968c6dc60ef717b1853d86023d1088a4d6a5011c72eba73df272675";
const REAL_SOURCE_DIGEST = "e159a4baf82d19193ca6d473a5fc5edd92282796";
const REAL_TAG_REF = "refs/tags/v0.13.0";

function realPolicy(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return verify.defaultPolicy({
    expectedSubjectSha256: REAL_SUBJECT_SHA256,
    expectedSourceDigest: REAL_SOURCE_DIGEST,
    expectedSignerDigest: REAL_SOURCE_DIGEST,
    expectedSourceRef: REAL_TAG_REF,
    repositoryId: "1296432215",
    ...overrides,
  });
}

test("POSITIVE (real gh 2.96.0 fixture): v0.13.0 verifies true", async () => {
  const gh = await fixture("positive-real-v0.13.0.json");
  const result = verify.evaluateVerification(gh, realPolicy());
  assert.equal(result.ok, true, result.reasons.join("; "));
});

test("real fixture: repository id is read from sourceRepositoryIdentifier", async () => {
  const gh = (await fixture("positive-real-v0.13.0.json")) as GhResults;
  const cert = gh[0]!.verificationResult!.signature!.certificate!;
  assert.equal(typeof cert.sourceRepositoryIdentifier, "string");
  assert.equal(cert.sourceRepositoryID, undefined);
  assert.equal(cert.extensions, undefined);
  assert.equal(verify.checkCertificateExtensions(cert, realPolicy()).ok, true);
});

test("NEGATIVE (real fixture): wrong repository id", async () => {
  const gh = structuredClone(
    await fixture("positive-real-v0.13.0.json"),
  ) as GhResults;
  gh[0]!.verificationResult!.signature!.certificate!.sourceRepositoryIdentifier =
    "999999";
  assert.equal(verify.evaluateVerification(gh, realPolicy()).ok, false);
});

test("NEGATIVE (real fixture): wrong source digest", async () => {
  const gh = structuredClone(
    await fixture("positive-real-v0.13.0.json"),
  ) as GhResults;
  gh[0]!.verificationResult!.signature!.certificate!.sourceRepositoryDigest =
    "d".repeat(40);
  assert.equal(verify.evaluateVerification(gh, realPolicy()).ok, false);
});

test("NEGATIVE (real fixture): wrong signer", async () => {
  const gh = structuredClone(
    await fixture("positive-real-v0.13.0.json"),
  ) as GhResults;
  gh[0]!.verificationResult!.signature!.certificate!.buildSignerURI =
    "https://github.com/attacker/evil/.github/workflows/release.yml@refs/tags/v0.13.0";
  assert.equal(verify.evaluateVerification(gh, realPolicy()).ok, false);
});

test("NEGATIVE (real fixture): wrong predicate type", async () => {
  const gh = structuredClone(
    await fixture("positive-real-v0.13.0.json"),
  ) as Array<Record<string, Record<string, Record<string, unknown>>>>;
  gh[0]!.verificationResult!.statement!.predicateType =
    "https://slsa.dev/provenance/v0.2";
  assert.equal(verify.evaluateVerification(gh, realPolicy()).ok, false);
});

test("NEGATIVE (real fixture): self-hosted runner", async () => {
  const gh = structuredClone(
    await fixture("positive-real-v0.13.0.json"),
  ) as GhResults;
  gh[0]!.verificationResult!.signature!.certificate!.runnerEnvironment =
    "self-hosted";
  assert.equal(verify.evaluateVerification(gh, realPolicy()).ok, false);
});

test("NEGATIVE (real fixture): a different VALID tag ref is rejected", async () => {
  const gh = structuredClone(
    await fixture("positive-real-v0.13.0.json"),
  ) as GhResults;
  gh[0]!.verificationResult!.signature!.certificate!.sourceRepositoryRef =
    "refs/tags/v0.14.0";
  assert.equal(verify.evaluateVerification(gh, realPolicy()).ok, false);
});

// ---- validateGhShape --------------------------------------------------------

test("validateGhShape: non-array fails closed; empty array and real/legacy fixtures are shape-valid", async () => {
  assert.equal(verify.validateGhShape({ not: "array" }).ok, false);
  assert.equal(verify.validateGhShape("nope").ok, false);
  assert.equal(verify.validateGhShape(null).ok, false);
  assert.equal(verify.validateGhShape([]).ok, true);
  assert.equal(
    verify.validateGhShape(await fixture("positive-real-v0.13.0.json")).ok,
    true,
  );
  assert.equal(verify.validateGhShape(await fixture("positive.json")).ok, true);
});

test("validateGhShape: rejects an entry missing verificationResult/statement/certificate", async () => {
  assert.equal(verify.validateGhShape([{}]).ok, false);

  const noStatement = structuredClone(
    await fixture("positive-real-v0.13.0.json"),
  ) as GhResults;
  delete noStatement[0]!.verificationResult!.statement;
  const noStatementResult = verify.validateGhShape(noStatement);
  assert.equal(noStatementResult.ok, false);
  assert.ok(noStatementResult.reasons.some((r) => r.includes("statement")));

  const noCert = structuredClone(
    await fixture("positive-real-v0.13.0.json"),
  ) as GhResults;
  delete (noCert[0]!.verificationResult!.signature as Record<string, unknown>)
    .certificate;
  const noCertResult = verify.validateGhShape(noCert);
  assert.equal(noCertResult.ok, false);
  assert.ok(noCertResult.reasons.some((r) => r.includes("certificate")));
});

test("validateGhShape: rejects a certificate with no recognized repository-id field", async () => {
  const gh = structuredClone(
    await fixture("positive-real-v0.13.0.json"),
  ) as GhResults;
  delete gh[0]!.verificationResult!.signature!.certificate!
    .sourceRepositoryIdentifier;
  const result = verify.validateGhShape(gh);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("repository-id")));
});

// ---- gh version pinning -----------------------------------------------------

test("parseGhVersion parses gh --version output", () => {
  const raw =
    "gh version 2.96.0 (2026-07-02)\nhttps://github.com/cli/cli/releases/tag/v2.96.0\n";
  assert.deepEqual(verify.parseGhVersion(raw), {
    major: 2,
    minor: 96,
    patch: 0,
  });
  assert.equal(verify.parseGhVersion("no version here"), null);
  assert.equal(verify.parseGhVersion(undefined), null);
  assert.equal(verify.parseGhVersion(123 as unknown as string), null);
});

test("isSupportedGhVersion: accepts 2.96 and 2.90 (the configured floor); rejects other majors and a below-floor minor", () => {
  const policy = verify.defaultPolicy();
  assert.equal(
    verify.isSupportedGhVersion({ major: 2, minor: 96, patch: 0 }, policy),
    true,
  );
  assert.equal(
    verify.isSupportedGhVersion({ major: 2, minor: 90, patch: 0 }, policy),
    true,
  );
  assert.equal(
    verify.isSupportedGhVersion({ major: 1, minor: 99, patch: 0 }, policy),
    false,
  );
  assert.equal(
    verify.isSupportedGhVersion({ major: 3, minor: 0, patch: 0 }, policy),
    false,
  );
  assert.equal(
    verify.isSupportedGhVersion({ major: 2, minor: 89, patch: 9 }, policy),
    false,
  );
  assert.equal(verify.isSupportedGhVersion(null, policy), false);
});

// ---- install-verified pure decision functions ------------------------------

function approvalPolicy(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    approvedVersions: { "1.0.0": "a".repeat(40) },
    denylist: [],
    ...overrides,
  };
}

test("checkApproval: approved version+commit passes", () => {
  const result = install.checkApproval(
    "1.0.0",
    "a".repeat(40),
    approvalPolicy(),
  );
  assert.equal(result.ok, true, result.reasons.join("; "));
});

test("checkApproval: fails closed on unlisted version, wrong commit, denied version/commit, and empty input", () => {
  assert.equal(
    install.checkApproval("9.9.9", "a".repeat(40), approvalPolicy()).ok,
    false,
    "unlisted version",
  );
  assert.equal(
    install.checkApproval("1.0.0", "b".repeat(40), approvalPolicy()).ok,
    false,
    "wrong commit for the approved version",
  );
  assert.equal(
    install.checkApproval(
      "1.0.0",
      "a".repeat(40),
      approvalPolicy({ denylist: ["1.0.0"] }),
    ).ok,
    false,
    "denied version",
  );
  assert.equal(
    install.checkApproval(
      "1.0.0",
      "a".repeat(40),
      approvalPolicy({ denylist: ["a".repeat(40)] }),
    ).ok,
    false,
    "denied commit",
  );
  assert.equal(
    install.checkApproval("", "", approvalPolicy()).ok,
    false,
    "empty",
  );
  assert.equal(
    install.checkApproval(undefined, undefined, approvalPolicy()).ok,
    false,
    "missing",
  );
});

test("checkApproval: accepts an array-form approvedVersions list", () => {
  const policy = {
    approvedVersions: [{ version: "2.0.0", commit: "c".repeat(40) }],
    denylist: [],
  };
  assert.equal(install.checkApproval("2.0.0", "c".repeat(40), policy).ok, true);
  assert.equal(
    install.checkApproval("2.0.0", "d".repeat(40), policy).ok,
    false,
  );
});

function validBreakGlass(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Date.now();
  return {
    approver: "jane-doe-security-lead",
    issuedAtMs: now,
    expiresAtMs: now + 60 * 60 * 1000,
    verified: false,
    ...overrides,
  };
}

test("validateBreakGlass: a valid record passes", () => {
  const now = Date.now();
  const result = install.validateBreakGlass(validBreakGlass(), now);
  assert.equal(result.ok, true, result.reasons.join("; "));
});

test("validateBreakGlass: fails closed on missing approver, expired, verified!==false, over-max-lifetime, and missing record", () => {
  const now = Date.now();
  assert.equal(
    install.validateBreakGlass(validBreakGlass({ approver: "" }), now).ok,
    false,
    "missing approver",
  );
  assert.equal(
    install.validateBreakGlass(
      validBreakGlass({ expiresAtMs: now - 1000 }),
      now,
    ).ok,
    false,
    "expired",
  );
  assert.equal(
    install.validateBreakGlass(validBreakGlass({ verified: true }), now).ok,
    false,
    "verified must be false",
  );
  const day = 24 * 60 * 60 * 1000;
  assert.equal(
    install.validateBreakGlass(
      validBreakGlass({
        issuedAtMs: now,
        expiresAtMs: now + 4 * day, // 96h > default 72h max lifetime
      }),
      now,
    ).ok,
    false,
    "over max lifetime",
  );
  assert.equal(
    install.validateBreakGlass(undefined, now).ok,
    false,
    "missing record",
  );
  assert.equal(install.validateBreakGlass(null, now).ok, false, "null record");
});

test("checkSeedIntegrity: matching 64-hex digests pass; mismatch/short/empty fail closed", () => {
  assert.equal(
    install.checkSeedIntegrity("a".repeat(64), "a".repeat(64)).ok,
    true,
  );
  assert.equal(
    install.checkSeedIntegrity("a".repeat(64), "b".repeat(64)).ok,
    false,
    "mismatch",
  );
  assert.equal(
    install.checkSeedIntegrity("a".repeat(10), "a".repeat(64)).ok,
    false,
    "short",
  );
  assert.equal(install.checkSeedIntegrity("", "").ok, false, "empty");
  assert.equal(
    install.checkSeedIntegrity(undefined, "a".repeat(64)).ok,
    false,
    "missing",
  );
});

function decideBase(
  overrides: Partial<{
    verify: CheckResult;
    approval: CheckResult;
    freshness: CheckResult;
    seedIntegrity: CheckResult;
    offline: boolean;
    breakGlass: Record<string, unknown>;
    policy: Record<string, unknown>;
    nowMs: number;
  }> = {},
) {
  const nowMs = Date.now();
  return {
    verify: { ok: true, reasons: [] },
    approval: { ok: true, reasons: [] },
    freshness: { ok: true, reasons: [] },
    seedIntegrity: { ok: true, reasons: [] },
    offline: false,
    policy: {},
    nowMs,
    ...overrides,
  };
}

test("decideInstall: promotes only when verify, approval, and seed integrity all pass", () => {
  const decision = install.decideInstall(decideBase());
  assert.equal(decision.action, "promote");
});

test("decideInstall: refuses on failed verify with no valid exception", () => {
  const decision = install.decideInstall(
    decideBase({ verify: { ok: false, reasons: ["no attestation found"] } }),
  );
  assert.equal(decision.action, "refuse");
  assert.ok(decision.reasons.some((r) => r.includes("no attestation found")));
});

test("decideInstall: refuses a replayed/denied version even when verify passed", () => {
  const decision = install.decideInstall(
    decideBase({ approval: { ok: false, reasons: ["version is denied"] } }),
  );
  assert.equal(decision.action, "refuse");
  assert.ok(decision.reasons.some((r) => r.includes("denied")));
});

test("decideInstall: refuses on seed-integrity mismatch even when verify and approval passed", () => {
  const decision = install.decideInstall(
    decideBase({
      seedIntegrity: { ok: false, reasons: ["archive digest mismatch"] },
    }),
  );
  assert.equal(decision.action, "refuse");
  assert.ok(decision.reasons.some((r) => r.includes("mismatch")));
});

test("decideInstall: keep-pinned only when offline, unverifiable, policy allows it, and the pinned version is approved+fresh", () => {
  const decision = install.decideInstall(
    decideBase({
      verify: { ok: false, reasons: ["offline"] },
      offline: true,
      policy: { allowOfflineLastKnownGood: true },
    }),
  );
  assert.equal(decision.action, "keep-pinned");
});

test("decideInstall: refuses keep-pinned when stale beyond max age", () => {
  const decision = install.decideInstall(
    decideBase({
      verify: { ok: false, reasons: ["offline"] },
      offline: true,
      freshness: { ok: false, reasons: ["offline bundle exceeds max age"] },
      policy: { allowOfflineLastKnownGood: true },
    }),
  );
  assert.equal(decision.action, "refuse");
});

test("decideInstall: refuses keep-pinned when policy does not permit stale operation", () => {
  const decision = install.decideInstall(
    decideBase({
      verify: { ok: false, reasons: ["offline"] },
      offline: true,
      policy: {}, // allowOfflineLastKnownGood not set
    }),
  );
  assert.equal(decision.action, "refuse");
});

test("decideInstall: break-glass only with a valid record and policy permission; never reported as verified", () => {
  const nowMs = Date.now();
  const decision = install.decideInstall(
    decideBase({
      verify: { ok: false, reasons: ["no attestation found"] },
      breakGlass: validBreakGlass(),
      policy: { allowBreakGlass: true },
      nowMs,
    }),
  );
  assert.equal(decision.action, "break-glass");
});

test("decideInstall: refuses an invalid/expired/without-approver break-glass record", () => {
  const nowMs = Date.now();
  const expired = install.decideInstall(
    decideBase({
      verify: { ok: false, reasons: ["no attestation found"] },
      breakGlass: validBreakGlass({ expiresAtMs: nowMs - 1000 }),
      policy: { allowBreakGlass: true },
      nowMs,
    }),
  );
  assert.equal(expired.action, "refuse");

  const noApprover = install.decideInstall(
    decideBase({
      verify: { ok: false, reasons: ["no attestation found"] },
      breakGlass: validBreakGlass({ approver: "" }),
      policy: { allowBreakGlass: true },
      nowMs,
    }),
  );
  assert.equal(noApprover.action, "refuse");

  const policyDenies = install.decideInstall(
    decideBase({
      verify: { ok: false, reasons: ["no attestation found"] },
      breakGlass: validBreakGlass(),
      policy: {}, // allowBreakGlass not set
      nowMs,
    }),
  );
  assert.equal(policyDenies.action, "refuse");
});

test("decideInstall: break-glass never applies when verify passed but approval/seed-integrity failed", () => {
  const decision = install.decideInstall(
    decideBase({
      approval: { ok: false, reasons: ["version is denied"] },
      breakGlass: validBreakGlass(),
      policy: { allowBreakGlass: true },
    }),
  );
  // verify.ok is true, so break-glass must not engage even though a valid
  // record and policy permission are present; a denied/replayed version on
  // otherwise-verified bytes must refuse.
  assert.equal(decision.action, "refuse");
});
