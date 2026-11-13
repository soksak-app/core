import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("the registry TLS target fails and names the file when the authority file holds no certificate", { timeout: 30000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "e2e-registry-tls-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // An authority file that exists and is empty. The target keeps an existing ca.pem and parses it, so the parse judges the empty file
  // of the test as it judges any file of the folder.
  const folder = join(root, "config", "soksak-check-registry-tls");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "ca.pem"), "");
  const run = spawnSync("make", ["--no-print-directory", "create-test-certificates"], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, SOKSAK_CONFIG_ROOT: join(root, "config") },
  });
  assert.notEqual(run.status, 0, `make create-test-certificates accepted an empty certificate: ${run.stdout}`);
  assert.match(run.stderr, /soksak-check-registry-tls\/ca\.pem holds no certificate/);
});

test("the registry TLS target writes only its own extensions, whatever the openssl configuration of the machine adds", { timeout: 30000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "e2e-registry-tls-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A machine configuration that adds extensions to every self-signed certificate, as the default configuration of some openssl
  // releases does; its basicConstraints repeats one that the target declares, which gives a certificate with a duplicate extension.
  writeFileSync(join(root, "machine.cnf"), "[req]\ndistinguished_name=name\nx509_extensions=machine\n[name]\n[machine]\nbasicConstraints=critical,CA:true\nnsComment=machine\n");
  const run = spawnSync("make", ["--no-print-directory", "create-test-certificates"], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, OPENSSL_CONF: join(root, "machine.cnf"), SOKSAK_CONFIG_ROOT: join(root, "config") },
  });
  assert.equal(run.status, 0, run.stderr);
  const text = spawnSync("openssl", ["x509", "-in", join(root, "config/soksak-check-registry-tls/ca.pem"), "-noout", "-text"], { encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
  assert.doesNotMatch(text.stdout, /Netscape Comment|machine/, "the authority certificate holds an extension of the machine configuration");
});
