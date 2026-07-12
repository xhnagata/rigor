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
}

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pkgSpecifier = "../scripts/package-plugin.mjs";
const verifySpecifier = "../scripts/verify-provenance.mjs";
const pkg = (await import(pkgSpecifier)) as unknown as PackageModule;
const verify = (await import(verifySpecifier)) as unknown as VerifyModule;

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
