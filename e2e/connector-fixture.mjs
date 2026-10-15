// The connector plugin of the window checks (docs/spec/installation.md#applications): a plugin named after the test
// application of the embed kit, whose surface mounts the embed page of core for that application, packed into a registry
// of the check beside the workspace plugins. Its release recipe reads a release that the check serves over https with the
// certificate of the check registry that `make e2e-registry-tls` creates, which the check applications trust through
// --registry-ca (docs/operations/examples.md).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { pluginEntry } from "../scripts/workspace-registry.mjs";
import { pluginChangeApplied } from "./fixture.mjs";

const REGISTRY = fileURLToPath(new URL("../target/registry/", import.meta.url));
const TLS = join(process.env.SOKSAK_CONFIG_ROOT ?? tmpdir(), "soksak-check-registry-tls");
const SIDECAR = "@soksak/sidecar-app";
export const APPLICATION = "embed-test-app";
export const PLUGIN = "kitconnector";

/** Packs the executable as a tar.gz release and serves it over https; returns its address, its SHA-256 and the close. */
export async function serveRelease(executable, folder) {
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
export function connectorRegistry(sok, present, release) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-connector-registry-"));
  for (const name of ["plugins", "sidecars", "packs", "revoked.json"]) cpSync(join(REGISTRY, name), join(folder, name), { recursive: true });
  const sidecars = new Set(readdirSync(join(folder, "sidecars")).map((file) => JSON.parse(readFileSync(join(folder, "sidecars", file), "utf8")).name));
  const sidecarVersion = JSON.parse(readFileSync(join(folder, "sidecars", readdirSync(join(folder, "sidecars")).find((file) =>
    JSON.parse(readFileSync(join(folder, "sidecars", file), "utf8")).name === SIDECAR)), "utf8")).versions.at(-1).version;
  const source = join(folder, "source");
  mkdirSync(source);
  const pkg = {
    name: `@soksak/plugin-${PLUGIN}`, version: "0.0.1", description: "The connector of the test application of the embed kit.",
    license: "MIT", repository: { type: "git", url: "git+https://example.invalid/kitconnector.git" },
    engines: { soksak: ">=0.0.1 <1.0.0" }, files: ["plugin.json", "events.json", "ui/surface.js"],
  };
  const id = PLUGIN;
  const manifest = {
    id, name: "시험 애플리케이션", description: "embed kit 시험 애플리케이션을 카드에 띄운다.",
    mark: "▣", icon: "<rect x=\"2\" y=\"3\" width=\"12\" height=\"10\" rx=\"2\"/>",
    surface: {
      module: "ui/surface.js",
      composition: { kind: "hybrid", regions: [{ name: "view", kind: "image", sidecar: SIDECAR, input: "dom" }], overlays: [] },
    },
    events: "events.json",
    settings: { arguments: { label: "실행 인자", description: "애플리케이션에 넘길 인자의 JSON 배열.", type: "string", default: "[]", maxLength: 4096 } },
    dependencies: { [SIDECAR]: `^${sidecarVersion}` },
    exposes: {
      status: [{ name: `${id}.state`, description: "The application of the surface.", schema: { type: "object", properties: {
        program: { type: ["string", "null"] }, pid: { type: ["integer", "null"] }, toolkit: { type: ["string", "null"] }, cursor: { type: "string" },
        title: { type: ["string", "null"] }, exit: { type: ["string", "null"] }, error: { type: ["string", "null"] } } } }],
      commands: [
        { name: `${id}.focus`, description: "Transfers keyboard ownership to the application.", params: { type: "object", properties: {} }, result: { type: "null" } },
        { name: `${id}.input`, description: "Sends one input message of the embed protocol.", params: { type: "object", properties: { message: { type: "object" } } }, result: { type: "null" } },
      ],
      dom: [{ name: `${id}.view`, description: "The area that shows the application." }],
    },
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
  const events = { schema: 2, layers: ["plugin"], events: Object.fromEntries([
    ["open", "lifecycle", "info", { program: "string" }], ["input", "input", "trace", { type: "string" }],
    ["message", "io", "debug", { event: "string" }], ["error", "call", "warn", { error: "string" }],
  ].map(([name, kind, level, fields]) => [`plugin.${id}.${name}`, { layer: "plugin", class: kind, level, fields, description: `The ${name} of the application.` }])) };
  mkdirSync(join(source, "ui"));
  writeFileSync(join(source, "ui", "surface.js"), `import { mountApplication } from "@soksak/plugin-api";\n` +
    `export function mount(root, context) { return mountApplication(root, context, { application: "${APPLICATION}" }); }\n`);
  writeFileSync(join(source, "events.json"), JSON.stringify(events, null, 2));
  writeFileSync(join(source, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(source, "plugin.json"), JSON.stringify(manifest, null, 2));
  const pack = JSON.parse(execFileSync(sok, ["plugin", "pack", source, join(folder, "releases")], { encoding: "utf8" }));
  writeFileSync(join(folder, "plugins", `${PLUGIN}.json`), JSON.stringify(pluginEntry(manifest, pkg, pack, sidecars), null, 2));
  execFileSync(sok, ["registry", "build", folder], { encoding: "utf8" });
  return folder;
}

/** Installs the connector plugin and waits until the window applied the change. */
export async function install(s) {
  const offsets = currentEventOffsets(s.app.configDir);
  await s.run("core.plugins.install", { plugin: PLUGIN });
  await pluginChangeApplied(s, offsets, `install ${PLUGIN}`);
}

/** Removes the connector plugin when it is installed and waits until the window applied the change. */
export async function remove(s) {
  if (!(await s.get("core.plugins")).plugins.find((row) => row.id === PLUGIN)?.installed) return;
  const offsets = currentEventOffsets(s.app.configDir);
  await s.run("core.plugins.remove", { plugin: PLUGIN });
  await pluginChangeApplied(s, offsets, `remove ${PLUGIN}`);
}


/**
 * Connects the executable as the application of the connector plugin: the check serves its release, uses a registry with
 * the plugin and installs it. With place, the check copies the executable to a folder of its own where the locate entry
 * finds it, so the check can remove it; without, the locate entry finds the executable where it is, for an application
 * that needs the files beside it. Every step is undone in the cleanup of the session, which restores the registry.
 */
export async function connectApplication(s, executable, { place = true } = {}) {
  const before = (await s.get("core.plugins")).registry;
  const work = mkdtempSync(join(tmpdir(), "soksak-connector-"));
  s.cleanup(() => rmSync(work, { recursive: true, force: true }));
  const release = await serveRelease(executable, work);
  s.cleanup(release.close);
  const present = place ? join(work, APPLICATION) : executable;
  const folder = connectorRegistry(join(dirname(s.app.binary), "sok"), present, release);
  s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
  // The cleanups run in the reverse order of their registration and each runs also when an earlier one failed, so the
  // registry of before is restored after the removal of the plugin even when that removal fails.
  s.cleanup(() => s.run("core.plugins.registry", { index: before }));
  s.cleanup(async () => {
    await s.windows(1, "the page was not ready for the cleanup");
    // The cards of the plugin close before its removal stops the application sidecar.
    for (const card of (await s.get("core.grid")).cards) {
      for (const tab of card.tabs.filter((item) => item.plugin === PLUGIN)) await s.run("core.tab.close", { tab: tab.id });
    }
    await remove(s);
  });
  await s.run("core.plugins.registry", { index: pathToFileURL(join(folder, "index.json")).href });
  await s.until("core.plugins", (value) => value.plugins.some((row) => row.id === PLUGIN), "the connector registry did not list the plugin");
  if (place) {
    copyFileSync(executable, present);
    chmodSync(present, 0o755);
  }
  await install(s);
  return { present, release, folder };
}
