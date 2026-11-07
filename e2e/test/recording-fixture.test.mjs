import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { packRecordingFixture, loadRecordingFixture } from "./recording-fixture.mjs";

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "soksak-recording-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture(root, path = "capture/frame.raw", bytes = Buffer.from("original native bytes")) {
  const directory = join(root, "fixture");
  mkdirSync(directory);
  writeFileSync(join(directory, "000000.gz"), gzipSync(bytes));
  const manifest = { format: 1, files: [{ path, gzip: "000000.gz", byteCount: bytes.length, sha256: sha(bytes) }] };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, manifest };
}

test("recording fixtures roundtrip native bytes and pack idempotently", { timeout: 10000 }, t => {
  const root = workspace(t), source = join(root, "source"), output = join(root, "fixture");
  mkdirSync(join(source, "capture", "sources"), { recursive: true });
  const bytes = Buffer.from([0, 255, 13, 10, 128, 0, 42]);
  writeFileSync(join(source, "evidence.json"), '{"original":true}\n');
  writeFileSync(join(source, "capture", "sources", "frame.bgra"), bytes);
  packRecordingFixture({ sourceDirectory: source, fixtureDirectory: output });
  const before = new Map(readdirSync(output).map(name => [name, readFileSync(join(output, name))]));
  packRecordingFixture({ sourceDirectory: source, fixtureDirectory: output });
  assert.deepEqual(readdirSync(output), [...before.keys()]);
  for (const [name, content] of before) assert.deepEqual(readFileSync(join(output, name)), content);
  const restored = loadRecordingFixture({ fixtureDirectory: output });
  try {
    assert.deepEqual(readFileSync(join(restored.directory, "capture", "sources", "frame.bgra")), bytes);
    assert.equal(readFileSync(join(restored.directory, "evidence.json"), "utf8"), '{"original":true}\n');
  } finally { restored.dispose(); }
  assert.throws(() => readFileSync(join(restored.directory, "evidence.json")), /ENOENT/);
});

test("recording fixture rejects a missing declared gzip file", { timeout: 10000 }, t => {
  const { directory } = fixture(workspace(t));
  rmSync(join(directory, "000000.gz"));
  assert.throws(() => loadRecordingFixture({ fixtureDirectory: directory }), /missing|ENOENT/);
});

for (const path of ["../escape", "/absolute", "C:/absolute", "capture/../../escape", "capture\\escape"]) {
  test(`recording fixture rejects unsafe native relative path ${path}`, { timeout: 10000 }, t => {
    const { directory } = fixture(workspace(t), path);
    assert.throws(() => loadRecordingFixture({ fixtureDirectory: directory }), /path|relative|traversal/i);
  });
}

test("recording fixture rejects native-byte digest tampering", { timeout: 10000 }, t => {
  const { directory, manifest } = fixture(workspace(t));
  manifest.files[0].sha256 = "0".repeat(64);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => loadRecordingFixture({ fixtureDirectory: directory }), /digest|sha256/i);
});

test("recording fixture rejects gzip storage traversal", { timeout: 10000 }, t => {
  const { directory, manifest } = fixture(workspace(t));
  manifest.files[0].gzip = "../outside.gz";
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => loadRecordingFixture({ fixtureDirectory: directory }), /path|relative|traversal/i);
});
