// Checks the plugin operations that read the public registry over https against the check-owned TLS registry (Fetching in docs/spec/installation.md).
//
// The check application is a diagnostic build and must have been started with the certificate authority that `make e2e-registry-tls` creates:
// `--registry-ca <root>/soksak-check-registry-tls/ca.pem` (docs/operations/examples.md). The check serves the workspace registry
// (target/registry that `make install-plugins` creates) over https and restores the original registry and installation when it ends.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { fresh, pluginChangeApplied } from "./fixture.mjs";

const TLS = join(process.env.SOKSAK_CONFIG_ROOT ?? tmpdir(), "soksak-check-registry-tls");
const REGISTRY = fileURLToPath(new URL("../target/registry/", import.meta.url));

/** Check-owned TLS registry. Each index variant has a path, and a release is served as /releases/<file>. */
async function serveRegistry() {
  for (const file of ["server.pem", "server-key.pem", "ca.pem"]) {
    if (!existsSync(join(TLS, file))) throw new Error(`${join(TLS, file)} is missing; run make e2e-registry-tls and start the check applications with --registry-ca ${join(TLS, "ca.pem")}`);
  }
  if (!existsSync(join(REGISTRY, "index.json"))) throw new Error(`${join(REGISTRY, "index.json")} is missing; run make install-plugins for the check configuration`);
  const original = JSON.parse(readFileSync(join(REGISTRY, "index.json"), "utf8"));
  const prefix = pathToFileURL(REGISTRY).href;
  const server = createServer({ cert: readFileSync(join(TLS, "server.pem")), key: readFileSync(join(TLS, "server-key.pem")) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `https://127.0.0.1:${server.address().port}`;
  // Replaces the file: address of the release with the address of this server. The sha256 stays the same because the file is the same.
  const index = JSON.parse(JSON.stringify(original).replaceAll(prefix, `${base}/releases/`));
  const browser = index.plugins.find((plugin) => plugin.id === "browser");
  const version = browser.versions.at(-1).version;
  const badHash = structuredClone(index);
  badHash.plugins.find((plugin) => plugin.id === "browser").versions.at(-1).release.sha256 = "0".repeat(64);
  const revoked = structuredClone(index);
  revoked.revoked.plugins.push({ id: "browser", version, reason: "registry window check" });
  const documents = { "/good/index.json": index, "/bad-hash/index.json": badHash, "/revoked/index.json": revoked };
  server.on("request", (request, response) => {
    if (documents[request.url]) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(documents[request.url]));
      return;
    }
    const release = request.url.startsWith("/releases/") ? join(REGISTRY, decodeURIComponent(request.url.slice("/releases/".length))) : null;
    if (release && !release.includes("..") && existsSync(release)) {
      response.writeHead(200);
      response.end(readFileSync(release));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return { base, version, close: () => new Promise((resolve) => server.close(resolve)) };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: plugin operations read an https registry and refuse a wrong hash, a revoked version and an unreachable registry`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const before = await s.get("core.plugins");
    const registry = await serveRegistry();
    // Restores the state so that the next check starts from the same registry and installation even if the check fails midway. The cleanup runs in the reverse order of the registration.
    s.cleanup(registry.close);
    s.cleanup(async () => {
      // A failure can leave the page reloading after the last operation; the host answers that the page is ready again.
      await s.windows(1, "the page was not ready for the cleanup");
      await s.run("core.plugins.registry", { index: before.registry });
      const now = await s.get("core.plugins");
      if (now.plugins.find((row) => row.id === "browser")?.installed) return;
      const offsets = currentEventOffsets(s.app.configDir);
      await s.run("core.plugins.install", { plugin: "browser" });
      await pluginChangeApplied(s, offsets, "the installation of the cleanup");
    });
    const use = async (path) => {
      const index = `${registry.base}${path}`;
      await s.run("core.plugins.registry", { index });
      return s.until("core.plugins", (value) => value.registry === index && value.error === null, `the registry did not change to ${index}`);
    };
    const remove = async () => {
      const offsets = currentEventOffsets(s.app.configDir);
      await s.run("core.plugins.remove", { plugin: "browser" });
      await pluginChangeApplied(s, offsets, "the removal");
      assert.ok(!(await s.get("core.plugins")).plugins.find((row) => row.id === "browser")?.installed, "browser was not removed");
    };
    const install = async (message) => {
      const offsets = currentEventOffsets(s.app.configDir);
      await s.run("core.plugins.install", { plugin: "browser" });
      await pluginChangeApplied(s, offsets, "the installation");
      const value = await s.get("core.plugins");
      assert.ok(value.plugins.find((row) => row.id === "browser")?.installed, message);
      return value;
    };

    await use("/good/index.json");
    await remove();
    const installed = await install("browser was not installed from the https registry");
    assert.equal(installed.plugins.find((row) => row.id === "browser").installed.version, registry.version);

    await use("/bad-hash/index.json");
    await remove();
    await assert.rejects(s.run("core.plugins.install", { plugin: "browser" }), /has sha256 [0-9a-f]{64}, the entry says 0{64}/);
    await use("/revoked/index.json");
    await assert.rejects(s.run("core.plugins.install", { plugin: "browser" }), /plugin browser has no version for core /);
    await use("/good/index.json");
    await install("browser was not installed again");

    // An unreachable registry names its address and the connection failure and does not change the current registry.
    const closed = `${registry.base}/good/index.json`;
    await registry.close();
    await assert.rejects(s.run("core.plugins.registry", { index: closed }), /cannot connect/);
  });
}
