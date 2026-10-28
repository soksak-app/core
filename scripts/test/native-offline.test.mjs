import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const nativeDarwin = join(root, "native/darwin");
const makefile = join(nativeDarwin, "Makefile");

function makeVariable(name) {
  const source = readFileSync(makefile, "utf8");
  const match = source.match(new RegExp(`^${name}\\s*:?=\\s*(\\S+)`, "m"));
  assert.ok(match, `native/darwin/Makefile does not declare ${name}`);
  return match[1];
}

function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-native-offline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fakeBin = join(directory, "bin");
  mkdirSync(fakeBin);
  const curlLog = join(directory, "curl.log");
  const fakeCurl = join(fakeBin, "curl");
  writeFileSync(fakeCurl, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_CURL_LOG\"\noutput=''\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = '-o' ]; then shift; output=$1; fi\n  shift\ndone\nif [ -n \"${FAKE_CURL_FIXTURE:-}\" ]; then cp \"$FAKE_CURL_FIXTURE\" \"$output\"; fi\nexit \"${FAKE_CURL_STATUS:-41}\"\n");
  chmodSync(fakeCurl, 0o755);
  return { directory, build: join(directory, "build"), curlLog, fakeBin };
}

function fetch(h, { offline = "1", expectedHash, fixture, curlStatus } = {}) {
  const variables = [`BUILD=${h.build}`, `OFFLINE=${offline}`];
  if (expectedHash) variables.push(`ZXING_SHA256=${expectedHash}`);
  const result = spawnSync("make", ["-C", nativeDarwin, ...variables, "fetch"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      PATH: `${h.fakeBin}:${process.env.PATH}`,
      FAKE_CURL_LOG: h.curlLog,
      ...(fixture ? { FAKE_CURL_FIXTURE: fixture } : {}),
      ...(curlStatus === undefined ? {} : { FAKE_CURL_STATUS: String(curlStatus) }),
    },
  });
  assert.ifError(result.error);
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function curlCalls(h) {
  return existsSync(h.curlLog) ? readFileSync(h.curlLog, "utf8").trim().split(/\r?\n/u).filter(Boolean) : [];
}

test("offline fetch reports the missing pinned release file before curl", { timeout: 10000 }, (t) => {
  const h = harness(t);
  const result = fetch(h);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /offline.*missing.*ZXing.*release file|missing.*ZXing.*release file.*offline/iu);
  assert.deepEqual(curlCalls(h), []);
  assert.deepEqual(existsSync(h.build) ? readdirSync(h.build) : [], []);
});

test("fetch rejects an unsupported OFFLINE value before creating build output", { timeout: 10000 }, (t) => {
  const h = harness(t);
  const result = fetch(h, { offline: "true" });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /OFFLINE must be 0 or 1/u);
  assert.deepEqual(curlCalls(h), []);
  assert.equal(existsSync(h.build), false);
});

test("offline fetch verifies a valid cached release file without extracting or compiling", { timeout: 10000 }, (t) => {
  const h = harness(t);
  const commit = makeVariable("ZXING_COMMIT");
  const releaseFile = join(h.build, `zxing-cpp-${commit}.tar.gz`);
  const fixture = Buffer.from("pinned release input fixture bytes\n");
  const expectedHash = createHash("sha256").update(fixture).digest("hex");
  mkdirSync(h.build);
  writeFileSync(releaseFile, fixture);

  const result = fetch(h, { expectedHash });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /OK/u);
  assert.deepEqual(curlCalls(h), []);
  assert.deepEqual(readFileSync(releaseFile), fixture);
  assert.deepEqual(readdirSync(h.build), [`zxing-cpp-${commit}.tar.gz`]);
});

test("online fetch downloads and verifies only the pinned release file", { timeout: 10000 }, (t) => {
  const h = harness(t);
  const commit = makeVariable("ZXING_COMMIT");
  const releaseFile = join(h.build, `zxing-cpp-${commit}.tar.gz`);
  const fixture = Buffer.from("downloaded pinned release input fixture bytes\n");
  const fixturePath = join(h.directory, "download.fixture");
  const expectedHash = createHash("sha256").update(fixture).digest("hex");
  writeFileSync(fixturePath, fixture);

  const result = fetch(h, { offline: "0", expectedHash, fixture: fixturePath, curlStatus: 0 });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /OK/u);
  assert.match(curlCalls(h)[0], new RegExp(`https://codeload\\.github\\.com/zxing-cpp/zxing-cpp/tar\\.gz/${commit}`));
  assert.match(curlCalls(h)[0], new RegExp(`-o ${releaseFile}\\.part$`));
  assert.deepEqual(readFileSync(releaseFile), fixture);
  assert.deepEqual(readdirSync(h.build), [`zxing-cpp-${commit}.tar.gz`]);
});

test("offline fetch rejects a cached release file whose hash differs", { timeout: 10000 }, (t) => {
  const h = harness(t);
  const commit = makeVariable("ZXING_COMMIT");
  const releaseFile = join(h.build, `zxing-cpp-${commit}.tar.gz`);
  const fixture = Buffer.from("corrupted cached release bytes\n");
  const expectedHash = createHash("sha256").update("different release bytes\n").digest("hex");
  mkdirSync(h.build);
  writeFileSync(releaseFile, fixture);

  const result = fetch(h, { expectedHash });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /FAILED|checksum|does not match/u);
  assert.deepEqual(curlCalls(h), []);
  assert.deepEqual(readFileSync(releaseFile), fixture);
});
