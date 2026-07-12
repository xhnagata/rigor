// Deterministic complete-plugin packaging for ADR 0001 producer provenance (#25).
//
// Produces a byte-reproducible `rigor-<version>.tar.gz` over the exact plugin
// file set and a detached `rigor-<version>.release-manifest.json`. Both become
// attested subjects in `.github/workflows/release.yml`. Attesting only
// `dist/rigor.cjs` would leave hooks, skills, agents, launcher, and manifests
// substitutable, so the archive binds the complete distributable tree.
//
// This script is PURE NODE: it implements a minimal ustar tar writer and
// normalizes the gzip header rather than shelling out to system `tar`/`gzip`,
// so the output does not depend on host tooling. Byte reproducibility holds
// within a pinned toolchain (CI Node 22, esbuild 0.25.6); the deflate stream is
// deterministic for a fixed Node/zlib build. A different Node major may emit a
// different deflate stream, which is acceptable: the release workflow both
// builds and packages on the pinned runner, and the detached manifest records
// the tool versions used.
//
// The manifest is intentionally NOT self-referential: it never records its own
// digest. A manifest packaged inside the archive could not record the digest of
// the archive containing it, so the archive digest lives only in this detached
// manifest beside the archive (ADR 0001 #25 step 2).

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, lstat, readdir, mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const REPOSITORY = "xhnagata/rigor";
const REPOSITORY_ID = "1296432215";
const WORKFLOW_PATH = ".github/workflows/release.yml";
const ESBUILD_VERSION = "0.25.6";
const SCHEMA_VERSION =
  "https://github.com/xhnagata/rigor/releases/schema/release-manifest/v1";
const TRUST_ANCHOR =
  "This manifest is release metadata, not a trust anchor. Trust derives from " +
  "verifying the GitHub Artifact Attestations against independently held " +
  "consumer policy; a manifest or checksum beside an artifact is not proof.";

// The exact, complete plugin file set. Any drift (a new skill, a removed file)
// must fail loudly rather than silently ship a partial or stale archive.
export const PLUGIN_FILES = [
  ".claude-plugin/marketplace.json",
  ".claude-plugin/plugin.json",
  "agents/rigor-reviewer.md",
  "bin/rigor",
  "dist/rigor.cjs",
  "hooks/hooks.json",
  "skills/assess/SKILL.md",
  "skills/attempt/SKILL.md",
  "skills/consult/SKILL.md",
  "skills/contract/SKILL.md",
  "skills/escalate/SKILL.md",
  "skills/orchestrate/SKILL.md",
  "skills/preflight/SKILL.md",
  "skills/retrospect/SKILL.md",
  "skills/review/SKILL.md",
  "skills/route/SKILL.md",
  "skills/setup/SKILL.md",
  "skills/verify/SKILL.md",
  "LICENSE",
  "README.md",
  "README.ja.md",
];

// Files packaged with the executable bit; every other file is 0644.
const EXECUTABLE_FILES = new Set(["bin/rigor"]);

// Directory roots whose entire recursive contents must be exactly the
// allowlisted files. An unexpected extra file under any of these roots is a
// packaging error (it would otherwise be silently omitted from the archive).
const PACKAGED_ROOTS = [
  ".claude-plugin",
  "agents",
  "bin",
  "dist",
  "hooks",
  "skills",
];

function modeFor(relPath) {
  return EXECUTABLE_FILES.has(relPath) ? 0o755 : 0o644;
}

async function walkRegularFiles(root, dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink())
      throw new Error(
        `refusing to package symlink: ${path.relative(root, full)}`,
      );
    if (info.isDirectory()) {
      await walkRegularFiles(root, full, out);
    } else if (info.isFile()) {
      out.push(path.relative(root, full).split(path.sep).join("/"));
    } else {
      throw new Error(
        `refusing to package non-regular file: ${path.relative(root, full)}`,
      );
    }
  }
}

/**
 * Read and validate the complete plugin file set from `root`. Returns staged
 * entries `{ name, mode, content }` (relative paths, POSIX separators). Throws
 * if any allowlisted file is missing, a symlink, or not a regular file, or if
 * a packaged root contains an unexpected entry.
 */
export async function collectPluginFiles(root) {
  const allow = new Set(PLUGIN_FILES);

  // Reject unexpected entries under the packaged directory roots.
  for (const rootDir of PACKAGED_ROOTS) {
    const abs = path.join(root, rootDir);
    const found = [];
    await walkRegularFiles(root, abs, found);
    for (const rel of found) {
      if (!allow.has(rel))
        throw new Error(`unexpected file under packaged root: ${rel}`);
    }
  }

  const entries = [];
  for (const rel of PLUGIN_FILES) {
    const abs = path.join(root, rel);
    let info;
    try {
      info = await lstat(abs);
    } catch {
      throw new Error(`missing required plugin file: ${rel}`);
    }
    if (info.isSymbolicLink())
      throw new Error(`refusing to package symlink: ${rel}`);
    if (!info.isFile())
      throw new Error(`refusing to package non-regular file: ${rel}`);
    const content = await readFile(abs);
    entries.push({ name: rel, mode: modeFor(rel), content });
  }
  return entries;
}

// ---- ustar tar writer -----------------------------------------------------

function writeAscii(buf, str, offset, length) {
  const bytes = Buffer.from(str, "ascii");
  if (bytes.length > length)
    throw new Error(`field too long for ustar header: ${str}`);
  bytes.copy(buf, offset);
}

// Octal numeric field: (length - 1) octal digits, zero-padded, then a NUL.
function writeOctal(buf, value, offset, length) {
  const digits = value.toString(8).padStart(length - 1, "0");
  if (digits.length > length - 1)
    throw new Error(`octal value too large for field: ${value}`);
  writeAscii(buf, digits, offset, length - 1);
  buf[offset + length - 1] = 0;
}

function ustarHeader({ name, mode, size, typeflag }) {
  const header = Buffer.alloc(512, 0);
  writeAscii(header, name, 0, 100);
  writeOctal(header, mode & 0o7777, 100, 8);
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12); // mtime = 0
  // checksum placeholder: 8 spaces while summing
  header.fill(0x20, 148, 156);
  writeAscii(header, typeflag, 156, 1);
  // linkname (157..256) left zero
  writeAscii(header, "ustar", 257, 6); // magic "ustar\0"
  header[262] = 0;
  writeAscii(header, "00", 263, 2); // version
  // uname/gname left empty (zero); devmajor/devminor/prefix left zero
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  const checksum = sum.toString(8).padStart(6, "0");
  writeAscii(header, checksum, 148, 6);
  header[154] = 0; // NUL
  header[155] = 0x20; // space
  return header;
}

/**
 * Build a deterministic ustar tar buffer from `entries`
 * `{ name, mode, type, content }`. `type` is "0" (file) or "5" (directory).
 * Entries are sorted bytewise (LC_ALL=C order) by name for stable output.
 */
export function buildTar(entries) {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")),
  );
  const chunks = [];
  for (const entry of sorted) {
    const isDir = entry.type === "5";
    const content = isDir ? Buffer.alloc(0) : entry.content;
    chunks.push(
      ustarHeader({
        name: entry.name,
        mode: entry.mode,
        size: content.length,
        typeflag: isDir ? "5" : "0",
      }),
    );
    if (content.length > 0) {
      chunks.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  // Two trailing zero blocks mark end of archive.
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

/**
 * Gzip a buffer deterministically: level 9, then overwrite the MTIME bytes
 * (offset 4..7) with 0 and the OS byte (offset 9) with 0xFF so the header
 * carries no host-specific state.
 */
export function normalizeGzip(buf) {
  const gz = gzipSync(buf, { level: 9 });
  gz[4] = 0;
  gz[5] = 0;
  gz[6] = 0;
  gz[7] = 0;
  gz[9] = 0xff;
  return gz;
}

/**
 * Assemble the complete `.tar.gz` for `version` from staged `entries`. Returns
 * `{ archive: Buffer, tarName, topDir }`.
 */
export function buildArchive(version, entries) {
  const topDir = `rigor-${version}`;
  const tarEntries = [{ name: `${topDir}/`, mode: 0o755, type: "5" }];
  for (const entry of entries) {
    tarEntries.push({
      name: `${topDir}/${entry.name}`,
      mode: entry.mode,
      type: "0",
      content: entry.content,
    });
  }
  const tar = buildTar(tarEntries);
  return {
    archive: normalizeGzip(tar),
    tarName: `${topDir}.tar.gz`,
    topDir,
  };
}

// ---- detached release manifest --------------------------------------------

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort())
      out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/** Canonical JSON: sorted keys, 2-space indent, LF, trailing newline. */
export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

/**
 * Build the detached release-manifest object. Pure: callers supply every
 * field, so tests need neither git nor a subprocess.
 */
export function buildManifest(fields) {
  const {
    version,
    tag,
    commit,
    sourceRef,
    workflowRef,
    workflowDigest,
    bundleSha256,
    archiveSha256,
    nodeVersion,
    repository = REPOSITORY,
    repositoryId = REPOSITORY_ID,
    workflowPath = WORKFLOW_PATH,
    esbuildVersion = ESBUILD_VERSION,
    archiveName = `rigor-${version}.tar.gz`,
  } = fields;
  return {
    schemaVersion: SCHEMA_VERSION,
    release: { tag, version },
    source: { repository, repositoryId, commit, ref: sourceRef },
    workflow: { path: workflowPath, ref: workflowRef, digest: workflowDigest },
    subjects: {
      bundle: { path: "dist/rigor.cjs", sha256: bundleSha256 },
      pluginArchive: { path: archiveName, sha256: archiveSha256 },
    },
    tools: { node: nodeVersion, esbuild: esbuildVersion },
    trustAnchor: TRUST_ANCHOR,
  };
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * Fail-closed structural + cross-field validation of a manifest object.
 * Returns `{ ok, reasons }`. Complements the JSON Schema (which cannot express
 * cross-field equalities such as tag == "v" + version).
 */
export function validateManifest(manifest) {
  const reasons = [];
  const m = manifest;
  const ok = (cond, why) => {
    if (!cond) reasons.push(why);
  };
  ok(m && typeof m === "object", "manifest is not an object");
  if (!m || typeof m !== "object") return { ok: false, reasons };

  ok(m.schemaVersion === SCHEMA_VERSION, "schemaVersion mismatch");
  const version = m.release?.version;
  const tag = m.release?.tag;
  ok(typeof version === "string", "release.version missing");
  ok(typeof tag === "string" && TAG_RE.test(tag), "release.tag malformed");
  ok(tag === `v${version}`, "release.tag is not v+version");

  ok(m.source?.repository === REPOSITORY, "source.repository mismatch");
  ok(m.source?.repositoryId === REPOSITORY_ID, "source.repositoryId mismatch");
  ok(HEX40.test(m.source?.commit ?? ""), "source.commit not 40-hex");
  ok(m.source?.ref === `refs/tags/${tag}`, "source.ref is not refs/tags/+tag");

  ok(m.workflow?.path === WORKFLOW_PATH, "workflow.path mismatch");
  ok(typeof m.workflow?.ref === "string", "workflow.ref missing");
  ok(HEX40.test(m.workflow?.digest ?? ""), "workflow.digest not 40-hex");

  ok(m.subjects?.bundle?.path === "dist/rigor.cjs", "bundle.path mismatch");
  ok(HEX64.test(m.subjects?.bundle?.sha256 ?? ""), "bundle.sha256 not 64-hex");
  ok(
    m.subjects?.pluginArchive?.path === `rigor-${version}.tar.gz`,
    "pluginArchive.path mismatch",
  );
  ok(
    HEX64.test(m.subjects?.pluginArchive?.sha256 ?? ""),
    "pluginArchive.sha256 not 64-hex",
  );

  ok(typeof m.tools?.node === "string", "tools.node missing");
  ok(m.tools?.esbuild === ESBUILD_VERSION, "tools.esbuild mismatch");
  ok(m.trustAnchor === TRUST_ANCHOR, "trustAnchor mismatch");

  return { ok: reasons.length === 0, reasons };
}

// ---- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.outdir) throw new Error("usage: package-plugin.mjs --outdir <dir>");
  const root = process.cwd();

  const manifestJson = JSON.parse(
    await readFile(path.join(root, ".claude-plugin/plugin.json"), "utf8"),
  );
  const version = manifestJson.version;
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`invalid plugin version: ${version}`);

  const commit =
    args["source-sha"] ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  if (!HEX40.test(commit)) throw new Error(`invalid source commit: ${commit}`);
  const tag = args.tag ?? `v${version}`;
  if (tag !== `v${version}`)
    throw new Error(`tag ${tag} does not match version v${version}`);
  const sourceRef = `refs/tags/${tag}`;
  const workflowRef =
    args["workflow-ref"] ?? `${REPOSITORY}/${WORKFLOW_PATH}@${sourceRef}`;
  const workflowDigest = args["workflow-sha"] ?? commit;
  if (!HEX40.test(workflowDigest))
    throw new Error(`invalid workflow digest: ${workflowDigest}`);

  const entries = await collectPluginFiles(root);
  const { archive, tarName } = buildArchive(version, entries);
  const bundle = entries.find((e) => e.name === "dist/rigor.cjs").content;
  const bundleSha256 = sha256Hex(bundle);
  const archiveSha256 = sha256Hex(archive);

  const manifest = buildManifest({
    version,
    tag,
    commit,
    sourceRef,
    workflowRef,
    workflowDigest,
    bundleSha256,
    archiveSha256,
    nodeVersion: process.versions.node,
    archiveName: tarName,
  });
  const check = validateManifest(manifest);
  if (!check.ok)
    throw new Error(`manifest failed validation: ${check.reasons.join("; ")}`);

  await mkdir(args.outdir, { recursive: true });
  const archivePath = path.join(args.outdir, tarName);
  const manifestPath = path.join(
    args.outdir,
    `rigor-${version}.release-manifest.json`,
  );
  await writeFile(archivePath, archive);
  await writeFile(manifestPath, canonicalJson(manifest));

  process.stdout.write(`archive: ${archivePath}\n`);
  process.stdout.write(`manifest: ${manifestPath}\n`);
  process.stdout.write(`bundle.sha256: ${bundleSha256}\n`);
  process.stdout.write(`pluginArchive.sha256: ${archiveSha256}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
