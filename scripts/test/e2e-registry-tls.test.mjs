import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("the registry TLS target fails and names the file when openssl writes no certificate", { timeout: 30000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "e2e-registry-tls-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A fault-injected openssl exits 0 and writes an empty file for each -out it receives.
  const bin = join(root, "bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "openssl"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = -out ] || [ "$1" = -keyout ]; then : > "$2"; fi; shift; done\n');
  chmodSync(join(bin, "openssl"), 0o755);
  const run = spawnSync("make", ["--no-print-directory", "e2e-registry-tls"], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SOKSAK_CONFIG_ROOT: join(root, "config") },
  });
  assert.notEqual(run.status, 0, `make e2e-registry-tls accepted an empty certificate: ${run.stdout}`);
  assert.match(run.stderr, /soksak-check-registry-tls\/ca\.pem holds no certificate/);
});
