// Checks the plugin operations that read the public registry over https against the check-owned TLS registry (Fetching in docs/spec/installation.md).
//
// The check application is a diagnostic build and must have been started with the certificate authority that `make create-test-certificates` creates:
// `--registry-ca <root>/soksak-check-registry-tls/ca.pem` (docs/operations/examples.md). The check serves the fixture registry that the
// application uses (scripts/fixture-registry.mjs) over https with the plain-view probe as the plugin of its operations, and restores the
// original registry and installation when it ends.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { readIndex, servedIndex, serveRegistry, withRevoked, withWrongHash } from "../scripts/fixture-registry.mjs";
import { fresh, pluginChangeApplied, restoreRegistry, useRegistry } from "./fixture.mjs";

const TLS = join(process.env.SOKSAK_CONFIG_ROOT ?? tmpdir(), "soksak-check-registry-tls");
/** The fixture plugin that the check removes and installs: the plain-view probe, which no start tab shows. */
const PLUGIN = "probeplain";

/**
 * Check-owned TLS registry of the fixture registry at the address `registry`. Each index variant has a path, and a release is served
 * at its path inside the registry folder.
 */
async function serveFixtureRegistry(registry) {
  for (const file of ["server.pem", "server-key.pem", "ca.pem"]) {
    if (!existsSync(join(TLS, file))) throw new Error(`${join(TLS, file)} is missing; run make create-test-certificates and start the check applications with --registry-ca ${join(TLS, "ca.pem")}`);
  }
  const { folder, index: original } = readIndex(registry);
  const version = original.plugins.find((plugin) => plugin.id === PLUGIN).versions.at(-1).version;
  const documents = {};
  const server = await serveRegistry(folder, documents, { cert: readFileSync(join(TLS, "server.pem")), key: readFileSync(join(TLS, "server-key.pem")) });
  const index = servedIndex(original, folder, server.base);
  documents["/good/index.json"] = index;
  documents["/bad-hash/index.json"] = withWrongHash(index, PLUGIN, version);
  documents["/revoked/index.json"] = withRevoked(index, PLUGIN, version, "registry window check");
  return { base: server.base, version, close: server.close };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: plugin operations read an https registry and refuse a wrong hash, a revoked version and an unreachable registry`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const registry = await serveFixtureRegistry((await s.get("core.plugins")).registry);
    // Restores the state so that the next check starts from the same registry and installation even if the check fails midway. The cleanup runs in the reverse order of the registration.
    s.cleanup(registry.close);
    s.cleanupSteps(
      async () => {
        // A failure can leave the page reloading after the last operation; the host answers that the page is ready again.
        await s.windows(1, "the page was not ready for the cleanup");
        await restoreRegistry(s);
      },
      async () => {
        // The installation waits for the ready page itself, because the step before it can fail before the page was ready.
        await s.windows(1, "the page was not ready for the cleanup");
        const now = await s.get("core.plugins");
        if (now.plugins.find((row) => row.id === PLUGIN)?.installed) return;
        const offsets = currentEventOffsets(s.app.configDir);
        await s.run("core.plugins.install", { plugin: PLUGIN });
        await pluginChangeApplied(s, offsets, "the installation of the cleanup");
      },
    );
    const use = async (path) => {
      const index = `${registry.base}${path}`;
      await useRegistry(s, index);
      return s.until("core.plugins", (value) => value.registry === index && value.error === null, `the registry did not change to ${index}`);
    };
    const remove = async () => {
      const offsets = currentEventOffsets(s.app.configDir);
      await s.run("core.plugins.remove", { plugin: PLUGIN });
      await pluginChangeApplied(s, offsets, "the removal");
      assert.ok(!(await s.get("core.plugins")).plugins.find((row) => row.id === PLUGIN)?.installed, `${PLUGIN} was not removed`);
    };
    const install = async (message) => {
      const offsets = currentEventOffsets(s.app.configDir);
      await s.run("core.plugins.install", { plugin: PLUGIN });
      await pluginChangeApplied(s, offsets, "the installation");
      const value = await s.get("core.plugins");
      assert.ok(value.plugins.find((row) => row.id === PLUGIN)?.installed, message);
      return value;
    };

    await use("/good/index.json");
    await remove();
    const installed = await install(`${PLUGIN} was not installed from the https registry`);
    assert.equal(installed.plugins.find((row) => row.id === PLUGIN).installed.version, registry.version);

    await use("/bad-hash/index.json");
    await remove();
    await assert.rejects(s.run("core.plugins.install", { plugin: PLUGIN }), /has sha256 [0-9a-f]{64}, the entry says 0{64}/);
    await use("/revoked/index.json");
    await assert.rejects(s.run("core.plugins.install", { plugin: PLUGIN }), new RegExp(`plugin ${PLUGIN} has no version for core `));
    await use("/good/index.json");
    await install(`${PLUGIN} was not installed again`);

    // An unreachable registry names its address and the connection failure and does not change the current registry.
    const closed = `${registry.base}/good/index.json`;
    await registry.close();
    await assert.rejects(s.run("core.plugins.registry", { index: closed }), /cannot connect/);
  });
}
