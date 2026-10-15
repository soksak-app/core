// Connector plugins end to end (docs/spec/installation.md#applications): a connector plugin of the test application of the
// embed kit is packed into a registry of its own beside the workspace plugins. Installed while its locate entry finds the
// application, the plugin connects that application and installs nothing; removed, installed again without it, the
// release recipe downloads a release of the application over https and installs it into the configuration folder. Each
// time an appview card with the setting program application:embed-test-app starts the connected application from its
// path. The application is the executable that SOKSAK_EMBED_TEST_APP names; the check fails with that name when it is not
// set. The check packs it as a tar.gz release and serves it over https with the certificate of the check registry that
// `make e2e-registry-tls` creates, which the check applications trust through --registry-ca (docs/operations/examples.md).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { pluginEntry } from "../scripts/workspace-registry.mjs";
import { fresh, pluginChangeApplied } from "./fixture.mjs";

const REGISTRY = fileURLToPath(new URL("../target/registry/", import.meta.url));
const APPLICATION = "embed-test-app";
const PLUGIN = "kitconnector";
const TLS = join(process.env.SOKSAK_CONFIG_ROOT ?? tmpdir(), "soksak-check-registry-tls");

/** Packs the executable as a tar.gz release and serves it over https; returns its address, its SHA-256 and the close. */
async function serveRelease(executable, folder) {
  for (const file of ["server.pem", "server-key.pem"]) {
    if (!existsSync(join(TLS, file))) throw new Error(`${join(TLS, file)} is missing; run make e2e-registry-tls and start the check applications with --registry-ca ${join(TLS, "ca.pem")}`);
  }
  const staged = join(folder, "staged");
  mkdirSync(staged);
  copyFileSync(executable, join(staged, APPLICATION));
  const packed = join(folder, `${APPLICATION}.tar.gz`);
  execFileSync("tar", ["-czf", packed, "-C", staged, APPLICATION]);
  const bytes = readFileSync(packed);
  const server = createServer({ cert: readFileSync(join(TLS, "server.pem")), key: readFileSync(join(TLS, "server-key.pem")) }, (request, response) => {
    if (request.url !== `/${APPLICATION}.tar.gz`) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200);
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `https://127.0.0.1:${server.address().port}/${APPLICATION}.tar.gz`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The connector plugin, whose locate entry is the path present, packed into a registry folder with the workspace plugins. */
function connectorRegistry(sok, present, release) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-connector-registry-"));
  for (const name of ["plugins", "sidecars", "packs", "revoked.json"]) cpSync(join(REGISTRY, name), join(folder, name), { recursive: true });
  const sidecars = new Set(readdirSync(join(folder, "sidecars")).map((file) => JSON.parse(readFileSync(join(folder, "sidecars", file), "utf8")).name));
  const appview = JSON.parse(readFileSync(join(folder, "plugins", "appview.json"), "utf8"));
  const source = join(folder, "source");
  mkdirSync(source);
  const pkg = {
    name: `@soksak/plugin-${PLUGIN}`, version: "0.0.1", description: "The connector of the test application of the embed kit.",
    license: "MIT", repository: { type: "git", url: "git+https://example.invalid/kitconnector.git" },
    engines: { soksak: ">=0.0.1 <1.0.0" }, files: ["plugin.json"],
  };
  const manifest = {
    id: PLUGIN, name: "시험 애플리케이션", description: "embed kit 시험 애플리케이션을 연결한다.",
    dependencies: { [appview.package]: `^${appview.versions.at(-1).version}` },
    application: {
      id: APPLICATION, name: "시험 애플리케이션", version: "0.0.2",
      platforms: {
        "darwin-arm64": {
          locate: [{ path: present }],
          recipe: { kind: "release", url: release.url, sha256: release.sha256, unpack: "tar.gz" },
          program: APPLICATION,
        },
      },
    },
  };
  writeFileSync(join(source, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(source, "plugin.json"), JSON.stringify(manifest, null, 2));
  const pack = JSON.parse(execFileSync(sok, ["plugin", "pack", source, join(folder, "releases")], { encoding: "utf8" }));
  writeFileSync(join(folder, "plugins", `${PLUGIN}.json`), JSON.stringify(pluginEntry(manifest, pkg, pack, sidecars), null, 2));
  execFileSync(sok, ["registry", "build", folder], { encoding: "utf8" });
  return folder;
}

/** Installs the connector plugin and waits until the window applied the change. */
async function install(s) {
  const offsets = currentEventOffsets(s.app.configDir);
  await s.run("core.plugins.install", { plugin: PLUGIN });
  await pluginChangeApplied(s, offsets, `install ${PLUGIN}`);
}

/** Removes the connector plugin when it is installed and waits until the window applied the change. */
async function remove(s) {
  if (!(await s.get("core.plugins")).plugins.find((row) => row.id === PLUGIN)?.installed) return;
  const offsets = currentEventOffsets(s.app.configDir);
  await s.run("core.plugins.remove", { plugin: PLUGIN });
  await pluginChangeApplied(s, offsets, `remove ${PLUGIN}`);
}

/** Opens an appview card and returns the program of the application once it connected. */
async function startedProgram(s) {
  const card = (await s.get("core.grid")).cards.find((item) => item.pane !== null).id;
  const { tab } = await s.run("core.card.add-tab", { card, plugin: "appview" });
  try {
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.surface === tab && item.exposes.includes("status appview.state")),
      "the appview card did not register appview.state");
    const state = await s.until("appview.state", (value) => value.toolkit !== null || value.error !== null,
      "the connected application did not start in the appview card", { surface: tab });
    assert.equal(state.error, null, `the appview card reported ${state.error}`);
    return state.program;
  } finally {
    await s.run("core.tab.close", { tab });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a connector plugin connects an installed application and installs an absent one`, { timeout: 300000 }, async (t) => {
    const executable = process.env.SOKSAK_EMBED_TEST_APP;
    assert.ok(executable, "SOKSAK_EMBED_TEST_APP is not set; it names the test application of the embed kit");
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s, { settings: { "appview.program": `application:${APPLICATION}`, "appview.arguments": "[]" } });
    await keepCommonSettings(s);
    const before = await s.get("core.plugins");
    const work = mkdtempSync(join(tmpdir(), "soksak-connector-"));
    s.cleanup(() => rmSync(work, { recursive: true, force: true }));
    const release = await serveRelease(executable, work);
    s.cleanup(release.close);
    const present = join(work, APPLICATION);
    const folder = connectorRegistry(join(dirname(app.binary), "sok"), present, release);
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    s.cleanup(async () => {
      await s.windows(1, "the page was not ready for the cleanup");
      await remove(s);
      await s.run("core.plugins.registry", { index: before.registry });
    });
    await s.run("core.plugins.registry", { index: pathToFileURL(join(folder, "index.json")).href });
    await s.until("core.plugins", (value) => value.plugins.some((row) => row.id === PLUGIN), "the connector registry did not list the plugin");

    // Present: the locate entry finds the application, which is connected where it is.
    copyFileSync(executable, present);
    execFileSync("chmod", ["755", present]);
    await install(s);
    assert.equal(await startedProgram(s), present, "the card did not start the application that the locate entry found");

    // Absent: the release recipe installs the application into the configuration folder.
    await remove(s);
    rmSync(present);
    await install(s);
    // The application resolves its configuration folder, so the recorded path is the resolved one.
    const installed = join(realpathSync(app.configDir), "applications", APPLICATION, "0.0.2", APPLICATION);
    assert.equal(await startedProgram(s), installed, "the card did not start the application that the recipe installed");
  });
}
