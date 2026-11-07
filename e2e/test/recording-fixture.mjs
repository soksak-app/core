// Losslessly stores recorded native files using standard, independent gzip files.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function relativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes(":") || value.includes("\0")) throw new Error("fixture path must be a portable relative path");
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..") || isAbsolute(value)) throw new Error(`unsafe fixture relative path: ${value}`);
  return parts;
}
function regularFile(path) {
  if (!lstatSync(path).isFile()) throw new Error(`fixture path is not a regular file: ${path}`);
  return readFileSync(path);
}

/** Explicit native source directory; no discovery of prior runs or replacement pixels. */
export function packRecordingFixture({ sourceDirectory, fixtureDirectory }) {
  if (!isAbsolute(sourceDirectory) || !isAbsolute(fixtureDirectory)) throw new Error("fixture source and output directories must be absolute");
  const source = resolve(sourceDirectory), output = resolve(fixtureDirectory);
  const contains = (parent, child) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep));
  };
  if (contains(source, output) || contains(output, source)) throw new Error("fixture source/output directories must be separate");
  const files = [];
  function visit(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = prefix + entry.name;
      relativePath(path);
      if (entry.isDirectory()) visit(join(directory, entry.name), path + "/");
      else if (entry.isFile()) files.push({ path, bytes: regularFile(join(directory, entry.name)) });
      else throw new Error(`fixture source contains a non-regular entry: ${path}`);
    }
  }
  if (!lstatSync(source).isDirectory()) throw new Error("fixture source must be a directory");
  visit(source);
  if (files.length === 0) throw new Error("fixture source has no native files");
  // Validate and read the source before replacing an existing owned fixture.
  mkdirSync(output, { recursive: true });
  for (const name of readdirSync(output)) {
    if (name !== "manifest.json" && !/^\d{6}\.gz$/.test(name)) throw new Error(`fixture output contains an unowned file: ${name}`);
  }
  for (const name of readdirSync(output)) rmSync(join(output, name));
  const manifest = { format: 1, files: files.map(({ path, bytes }, index) => {
    const gzip = `${String(index).padStart(6, "0")}.gz`;
    writeFileSync(join(output, gzip), gzipSync(bytes, { level: 9 }));
    return { path, gzip, byteCount: bytes.length, sha256: digest(bytes) };
  }) };
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/** Caller owns dispose(); every failure removes any partial extracted native tree. */
export function loadRecordingFixture({ fixtureDirectory }) {
  if (!isAbsolute(fixtureDirectory)) throw new Error("fixture directory must be absolute");
  const manifest = JSON.parse(regularFile(join(fixtureDirectory, "manifest.json")));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("invalid recording fixture manifest");
  const paths = new Set(), storage = new Set();
  for (const file of manifest.files) {
    relativePath(file.path);
    relativePath(file.gzip);
    if (!/^\d{6}\.gz$/.test(file.gzip) || paths.has(file.path) || storage.has(file.gzip) ||
        !Number.isSafeInteger(file.byteCount) || file.byteCount < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("invalid or duplicate fixture file declaration");
    paths.add(file.path); storage.add(file.gzip);
  }
  const directory = mkdtempSync(join(tmpdir(), "soksak-native-recording-"));
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  try {
    for (const file of manifest.files) {
      const bytes = gunzipSync(regularFile(join(fixtureDirectory, file.gzip)), { maxOutputLength: Math.max(1, file.byteCount) });
      if (bytes.length !== file.byteCount || digest(bytes) !== file.sha256) throw new Error(`fixture native-byte digest mismatch: ${file.path}`);
      const target = join(directory, ...relativePath(file.path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    return { directory, dispose };
  } catch (error) { dispose(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--output") throw new Error("usage: node e2e/test/recording-fixture.mjs --source <absolute native directory> --output <absolute fixture directory>");
  const manifest = packRecordingFixture({ sourceDirectory: args[1], fixtureDirectory: args[3] });
  process.stdout.write(`Stored ${manifest.files.length} original native files\n`);
}
