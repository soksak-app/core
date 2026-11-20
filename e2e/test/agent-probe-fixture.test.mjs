// The fixture plugins of the agent layout window check (docs/spec/cli.md#acting-on-a-layout): the agent probe, whose fixture
// sidecar starts for its surface a process that writes its SOKSAK_CONFIG_DIR and the output of `sok context`,
// and the agent open probe, whose surface.params takes path and address and whose surface.opens declares html. These tests hold
// the declarations that the applications read and the view logic of the probes without a window; the processes of the sidecar run
// in its own tests (e2e/fixtures/sidecars/agentprobe/tests/process.rs) and in the window check.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateManifest, validateSidecar } from "@soksak/plugin-api";

import { openView, turn } from "@soksak/plugin-api/testing";
import { SIDECAR, startAgentProbe } from "../fixtures/agent-probe/agentprobe/ui/agent-probe.js";
import { startAgentOpen } from "../fixtures/agent-probe/agentopen/ui/agent-open.js";

const CASES = new URL("../../docs/spec/cases/view-wire/", import.meta.url);

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROBE = join(ROOT, "e2e/fixtures/agent-probe/agentprobe");
const OPEN = join(ROOT, "e2e/fixtures/agent-probe/agentopen");
const SERVICE = join(ROOT, "e2e/fixtures/sidecars/agentprobe");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

test("the agent probe depends on its sidecar, which runs on standard input and output, and the packages share the workspace version", { timeout: 5000 }, () => {
  const manifest = validateManifest(read(join(PROBE, "plugin.json")));
  assert.deepEqual(Object.keys(manifest.dependencies), [SIDECAR]);
  assert.equal(read(join(PROBE, "package.json")).name, "@sok-check/agentprobe");
  const sidecar = validateSidecar(read(join(SERVICE, "sidecar.json")));
  assert.equal(sidecar.transport, undefined, "the sidecar of the agent probe is not a persistent service");
  assert.equal(sidecar.displayName, "soksak://sidecar/agentprobe");
  assert.equal(sidecar.processes, true, "the sidecar starts processes for surfaces and answers process queries");
  assert.deepEqual(sidecar.message, { form: "json-object", operationField: "operation" });
  const pkg = read(join(SERVICE, "package.json"));
  assert.equal(pkg.name, SIDECAR);
  for (const file of ["sidecar.json", sidecar.executable.split("/")[0]]) assert.ok(pkg.files.includes(file), `the release packs ${file}`);
  assert.equal(pkg.version, read(join(PROBE, "package.json")).version, "the probe and its sidecar share the workspace version");
  const cargo = readFileSync(join(SERVICE, "Cargo.toml"), "utf8");
  assert.match(cargo, /^\[workspace\]$/m, "the crate is not a member of the core workspace");
  assert.equal(/^version = "([^"]+)"$/m.exec(cargo)?.[1], pkg.version);
});

test("the agent open probe takes path and address as its tab params and opens html files", { timeout: 5000 }, () => {
  const manifest = validateManifest(read(join(OPEN, "plugin.json")));
  assert.equal(read(join(OPEN, "package.json")).name, "@sok-check/agentopen");
  assert.deepEqual(manifest.surface.params, { type: "object", properties: { path: { type: "string" }, address: { type: "string" } } });
  assert.deepEqual(manifest.surface.opens, { extensions: ["html"] });
});

const PROBE_MANIFEST = read(join(PROBE, "plugin.json"));
const START = { surface: "tab-4", params: null, origin: { directory: null }, project: null, section: null };
const SOK = "/Applications/soksak.app/Contents/MacOS/sok";

test("the agent probe starts the process of its surface through its sidecar and reports what the process wrote", { timeout: 5000 }, async () => {
  const view = await openView("agent-probe-fixture-process", { cases: CASES, start: START, declarations: PROBE_MANIFEST.exposes });
  await startAgentProbe({ bridge: view.bridge, expose: view.expose, view: view.window });
  assert.deepEqual(view.registered("status"), PROBE_MANIFEST.exposes.status.map((status) => status.name));
  assert.deepEqual(view.calls.filter(({ command }) => command === "runtime.command.register").map(({ params }) => params.name),
    PROBE_MANIFEST.exposes.commands.map((command) => command.name));
  assert.equal(await view.status("agentprobe.process"), null);
  await view.exposed("status.watch", { name: "agentprobe.process" });
  assert.equal(await view.run("agentprobe.start", { sok: SOK }), null);
  const process = { configDirectory: "/config",
    context: { status: 0, signal: null, stdout: '{"configDirectory":"/config","surface":"tab-4","window":"main"}\n', stderr: "" } };
  view.deliverNotice("sidecar.message", { id: "tab-4", body: { event: "process", ...process } });
  await turn();
  assert.deepEqual(await view.status("agentprobe.process"), process);
  assert.deepEqual(view.changes("agentprobe.process").at(-1), process);
  // An error of the sidecar goes to the application log and into the status.
  const error = "process of tab-4: run /missing/sok: No such file or directory (os error 2)";
  view.deliverNotice("sidecar.message", { id: "tab-4", body: { error } });
  await turn();
  assert.deepEqual(await view.status("agentprobe.process"), { error });
  assert.deepEqual(view.calls.filter(({ command }) => command === "runtime.error").map(({ params }) => params), [{ where: "agentprobe", text: error }]);
  // A start without the path of a sok program is refused and sends the sidecar nothing.
  await assert.rejects(view.run("agentprobe.start", { sok: "" }), { message: 'agentprobe.start needs sok, the path of a sok program, not ""' });
  assert.deepEqual(view.calls.filter(({ command }) => command === "runtime.sidecar.send").map(({ params }) => params),
    [{ id: "tab-4", sidecar: SIDECAR, body: { operation: "start", sok: SOK }, cids: [] }]);
  await view.close();
});

const OPEN_MANIFEST = read(join(OPEN, "plugin.json"));

test("the agent open probe reports the params of its tab", { timeout: 5000 }, async () => {
  const params = { path: "docs/index.html" };
  const view = await openView("agent-probe-fixture-open", { cases: CASES, start: { ...START, surface: "tab-5", params }, declarations: OPEN_MANIFEST.exposes });
  await startAgentOpen({ expose: view.expose, view: view.window });
  assert.deepEqual(view.registered("status"), OPEN_MANIFEST.exposes.status.map((status) => status.name));
  assert.deepEqual(await view.status("agentopen.params"), params);
  await view.close();
});
