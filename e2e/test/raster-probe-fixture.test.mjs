// The raster probe and its persistent sidecar serve as the vehicles of the core checks of
// image regions, frames and persistent sidecar services (docs/spec/plugin-processes.md#verification-boundaries). These tests hold
// the declarations that the applications read and the view logic of the probe without a window; the frames and the service run in
// the window checks.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";
import { validateManifest, validateSidecar } from "@soksak/plugin-api";
import { Session } from "@soksak/window-check/app.mjs";

import { openView, turn } from "@soksak/plugin-api/testing";
import { catalogOf, auditLogDirectories } from "../../scripts/check-events.mjs";
import { INPUT_LOG_LIMIT, REGION, SIDECAR, startRasterProbe } from "../fixtures/raster-probe/probe/ui/raster-probe.js";
import { presentRasterTab, RASTER_ENTRIES, rasterReady, reopenedSession } from "../raster-probe.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROBE = join(ROOT, "e2e/fixtures/raster-probe/probe");
const SERVICE = join(ROOT, "e2e/fixtures/sidecars/rasterprobe");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const BASE = read(join(ROOT, "docs/spec/events.json"));

test("the raster probe declares an image region that its sidecar dependency supplies, and the sidecar is a persistent service", { timeout: 5000 }, () => {
  const manifest = validateManifest(read(join(PROBE, "plugin.json")));
  const [region] = manifest.surface.composition.regions;
  assert.deepEqual(region, { name: REGION, kind: "image", sidecar: SIDECAR, present: "lease", input: "dom" });
  assert.deepEqual(Object.keys(manifest.dependencies), [SIDECAR]);
  assert.deepEqual(manifest.background, { sidecar: SIDECAR, operation: "open" });

  const sidecar = validateSidecar(read(join(SERVICE, "sidecar.json")));
  assert.equal(sidecar.transport, "persistent");
  assert.equal(sidecar.displayName, "soksak://sidecar/rasterprobe");
  assert.deepEqual(sidecar.message, { form: "json-object", operationField: "operation" });
  const pkg = read(join(SERVICE, "package.json"));
  assert.equal(pkg.name, SIDECAR);
  for (const file of ["sidecar.json", sidecar.events, sidecar.executable.split("/")[0]]) assert.ok(pkg.files.includes(file), `the release packs ${file}`);
  assert.equal(pkg.version, read(join(PROBE, "package.json")).version, "the probe and its sidecar share the workspace version");
});

test("the sidecar crate is its own workspace with the version of its package", { timeout: 5000 }, () => {
  const cargo = readFileSync(join(SERVICE, "Cargo.toml"), "utf8");
  assert.match(cargo, /^\[workspace\]$/m, "the crate is not a member of the core workspace");
  assert.equal(/^version = "([^"]+)"$/m.exec(cargo)?.[1], read(join(SERVICE, "package.json")).version);
  const members = /^members = \[(.*)\]$/m.exec(readFileSync(join(ROOT, "Cargo.toml"), "utf8"))?.[1];
  assert.ok(members !== undefined && !members.includes("e2e/"), "the core workspace lists no fixture crate");
});

/** A configuration folder that installed the probe and its sidecar at their fixture folders. */
function installedFolder() {
  const folder = mkdtempSync(join(tmpdir(), "rasterprobe-"));
  mkdirSync(join(folder, "plugins"));
  mkdirSync(join(folder, "logs"));
  writeFileSync(join(folder, "plugins", "installed.json"), JSON.stringify({
    format: 3,
    plugins: { rasterprobe: { path: relative(folder, PROBE) } },
    sidecars: { [SIDECAR]: { path: relative(folder, SERVICE) } },
  }));
  return folder;
}

test("the sidecar catalog composes with the core catalog and declares the lines that the service writes", { timeout: 5000 }, () => {
  const folder = installedFolder();
  try {
    const catalog = catalogOf(BASE, folder);
    for (const name of ["request", "session", "surface_mode", "frame", "connection", "kill", "exit", "start"]) {
      assert.equal(catalog.events[`sidecar.rasterprobe.${name}`]?.layer, "sidecar", name);
    }
    // The lines in the form of the writer of the service (src/events.rs): a host file names the run, and the files of the service
    // follow the name form <role>-<seconds>-<pid> with seq across its main and debug file.
    const clocks = (seq) => ({ ts_us: 1791500000000000 + seq, mono_ns: 1000 + seq, seq });
    const line = (seq, level, klass, event, fields, more = {}) => JSON.stringify({ ...clocks(seq), level, class: klass, layer: "sidecar", event, ...more, fields });
    const policy = { lifecycle: "debug", input: "debug", call: "debug", io: "debug", frame: "debug" };
    writeFileSync(join(folder, "logs", "host-1791500000-10.jsonl"), `${JSON.stringify({ ...clocks(1), level: "info", class: "lifecycle", layer: "host", event: "log.open", fields: { schema: 3, pid: 10, role: "host", boot: "1791500000-10" } })}\n`);
    writeFileSync(join(folder, "logs", "rasterprobe-1791500000-20.jsonl"), [
      line(1, "info", "lifecycle", "log.open", { schema: 3, pid: 20, role: "rasterprobe", boot: "1791500000-20" }),
      line(2, "info", "lifecycle", "log.policy", { source: "file", classes: policy }),
      line(3, "info", "lifecycle", "sidecar.rasterprobe.start", { pid: 20, version: "0.0.40", boot: "1791500000-20" }),
      line(4, "info", "lifecycle", "sidecar.rasterprobe.connection", { client: "/config", connected: true }),
      line(7, "info", "lifecycle", "sidecar.rasterprobe.session", { action: "open", cause: "open", child: 21 }, { surface: "tab-1", session: "s1", cids: ["b.1"] }),
      line(8, "info", "lifecycle", "sidecar.rasterprobe.surface_mode", { mode: "image", cause: "open" }, { surface: "tab-1", session: "s1" }),
      line(10, "info", "lifecycle", "sidecar.rasterprobe.session", { action: "close", cause: "closed", child: 21, error: null }, { surface: "tab-1", session: "s1" }),
      line(11, "warn", "lifecycle", "sidecar.rasterprobe.kill", { pid: 20 }, { surface: "tab-1" }),
      line(12, "info", "lifecycle", "sidecar.rasterprobe.exit", { cause: "SIGTERM", failures: [] }),
    ].join("\n") + "\n");
    writeFileSync(join(folder, "logs", "rasterprobe-1791500000-20.debug.jsonl"), [
      line(5, "info", "lifecycle", "log.open", { schema: 3, pid: 20, role: "rasterprobe", boot: "1791500000-20" }),
      line(6, "debug", "io", "sidecar.rasterprobe.request", { operation: "open", bytes: 80 }, { surface: "tab-1", cids: ["b.1"] }),
      line(9, "debug", "frame", "sidecar.rasterprobe.frame", { event: "frame", name: REGION, generation: 2, raster: 5, sequence: 1, width: 160, height: 96,
        scale: 2, grid: { rows: 3, cols: 10, cellWidth: 16, cellHeight: 32 }, rows: 3, color: "#0050b4", marker: "#020001", surface: 7, draw_us: 41, inputs: [1] }, { surface: "tab-1", session: "s1" }),
    ].join("\n") + "\n");
    assert.deepEqual(auditLogDirectories(BASE, [folder]), []);
    writeFileSync(join(folder, "logs", "rasterprobe-1791500000-20.debug.jsonl"),
      `${line(13, "info", "lifecycle", "log.open", { schema: 3, pid: 20, role: "rasterprobe", boot: "1791500000-20" })}\n${line(14, "debug", "frame", "sidecar.rasterprobe.painted", {})}\n`);
    assert.equal(auditLogDirectories(BASE, [folder]).filter((message) => message.includes("sidecar.rasterprobe.painted")).length, 1, "an undeclared line fails the audit");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

const START = { surface: "tab-9", params: null, origin: { directory: null }, project: null, section: null };
const MANIFEST = read(join(PROBE, "plugin.json"));

/**
 * Opens the view of the probe on the real view bridge and exposure and starts it; the wire is the case `wire`, which records the
 * composition of the manifest, the text size of the surface, and the attachment of the image region. `attaching` is an input event
 * that the region delivers while it attaches, and `textSizeAtOnce` tells the text size listener the factor as soon as it registers:
 * the case holds the reply of the call that the event follows, and the test delivers the notice and releases the reply.
 */
async function openProbe(wire, { attaching = null, textSizeAtOnce = false } = {}) {
  const view = await openView(wire, {
    start: START, declarations: MANIFEST.exposes,
    html: `<!doctype html><body><div id="${REGION}"></div></body>`,
    layout: { width: 640, height: 400, scale: 2, rect: () => ({ left: 0, top: 24, right: 400, bottom: 324, width: 400, height: 300 }) },
  });
  const imageEvent = (event) => view.deliverNotice("image-event", { name: REGION, event });
  const starting = startRasterProbe({ bridge: view.bridge, expose: view.expose, document: view.window.document, view: view.window });
  if (attaching !== null) {
    await turn();
    imageEvent(attaching);
    view.release();
  }
  if (textSizeAtOnce) {
    await turn();
    view.deliverNotice("textSize", 1.25);
    view.release();
  }
  await starting;
  const element = view.window.document.getElementById(REGION);
  return {
    view, element, imageEvent,
    // The requests of the view to the sidecar, in order.
    sent: () => view.calls.filter(({ command }) => command === "runtime.sidecar.send").map(({ params }) => ({ surface: params.id, body: params.body, cids: params.cids })),
    // The sidecar answers a request of the surface with a message that may carry cids, and the connection fails with a reason.
    answer: async (body, cids) => { view.deliverNotice("sidecar.message", { id: START.surface, body, ...(cids === undefined ? {} : { cids }) }); await turn(); },
    fail: async (reason) => { view.deliverNotice("sidecar.failure", { id: START.surface, reason }); await turn(); },
    textSize: async (value) => { view.deliverNotice("textSize", value); await turn(); },
    status: (name) => view.status(name),
    // The errors that the view shows on its own page, as `where: text`.
    errors: () => view.calls.filter(({ command }) => command === "runtime.error").map(({ params }) => `${params.where}: ${params.text}`),
    focuses: () => view.calls.filter(({ command }) => command === "image.focus").length,
  };
}

test("the probe opens its session with its image and reports the view, the session and the frames", { timeout: 5000 }, async () => {
  const probe = await openProbe("raster-probe-fixture-session");
  const { view } = probe;
  const registered = (kind) => view.registered(kind);
  assert.deepEqual(registered("status"), MANIFEST.exposes.status.map(({ name }) => name));
  assert.deepEqual(view.calls.filter(({ command }) => command === "runtime.command.register").map(({ params }) => params.name), MANIFEST.exposes.commands.map(({ name }) => name));
  assert.deepEqual(registered("element"), MANIFEST.exposes.element.map(({ name }) => name));
  assert.equal(probe.element.dataset.expose, "rasterprobe.raster", "the element entry is the image region element");
  assert.deepEqual(probe.sent(), [{ surface: "tab-9", body: { operation: "open", image: REGION, textSize: 1.25 }, cids: [] }]);
  assert.deepEqual(await probe.status("rasterprobe.view"), { width: 400, height: 300, left: 0, top: 24, deviceWidth: 800, deviceHeight: 600, devicePixelRatio: 2, textSize: 1.25 });
  assert.equal((await probe.status("rasterprobe.session")).connected, false);

  await view.exposed("status.watch", { name: "rasterprobe.frame" });
  await probe.answer({ event: "session", session: "s1", created: true, mode: "image", rows: 0 });
  await probe.answer({ event: "frame", generation: 2, raster: 5, sequence: 1, rows: 0, inputs: [] });
  assert.deepEqual(await probe.status("rasterprobe.session"), { event: "session", session: "s1", created: true, mode: "image", rows: 0, connected: true, failure: null, error: null });
  assert.deepEqual(view.changes("rasterprobe.frame").at(-1), { event: "frame", generation: 2, raster: 5, sequence: 1, rows: 0, inputs: [] });

  await view.run("rasterprobe.rows", { count: 4 });
  await view.run("rasterprobe.kill", {});
  assert.deepEqual(probe.sent().slice(1).map(({ body }) => body), [{ operation: "rows", count: 4 }, { operation: "kill" }]);
  await probe.answer({ event: "rows", count: 4 });
  assert.equal((await probe.status("rasterprobe.session")).rows, 4);
  await view.close();
});

test("the view opens its session before any other request, as a view of a reloaded page must", { timeout: 5000 }, async () => {
  // The region delivers a focus transaction while it attaches, to the input handler of the creation, and the text size listener is
  // told the factor at once: neither request reaches the sidecar before the open, which a surface whose session ended would refuse.
  const focus = { type: "input", actions: [{ type: "focus", focused: true }], preedit: null, errors: [], cids: ["n.1"] };
  const probe = await openProbe("raster-probe-fixture-session-first", { attaching: focus, textSizeAtOnce: true });
  await turn();
  const sent = probe.sent();
  assert.deepEqual(sent.map(({ body }) => body.operation), ["open", "input", "textSize"]);
  const order = probe.view.calls.map(({ command }) => command);
  const first = order.indexOf("runtime.sidecar.send");
  assert.ok(order.indexOf("runtime.sidecar.on") < first && order.indexOf("runtime.sidecar.onFailure") < first, "the view subscribes before its first request");
  for (const command of ["composition.declaration", "runtime.command.register", "runtime.textSize.on"]) {
    assert.ok(first < order.indexOf(command), `the open precedes ${command}`);
  }
  assert.deepEqual(sent[0].body, { operation: "open", image: REGION, textSize: 1.25 });
  assert.deepEqual(sent[1], { surface: "tab-9", body: { operation: "input", sequence: 1, actions: focus.actions, preedit: null }, cids: ["n.1"] });
  await probe.view.close();
});

test("the probe forwards region input with its cids, follows the text size and opens again on a connection notice", { timeout: 5000 }, async () => {
  const probe = await openProbe("raster-probe-fixture-input-connection");
  assert.equal(probe.sent()[0].body.textSize, 1, "an unknown text size is factor 1");
  probe.imageEvent({ type: "focus", focused: true });
  probe.imageEvent({ type: "input", actions: [{ type: "insert", text: "a" }], preedit: { text: "" }, errors: [], cids: ["n.7"] });
  await turn();
  assert.deepEqual(probe.sent()[1], { surface: "tab-9", body: { operation: "input", sequence: 1, actions: [{ type: "insert", text: "a" }], preedit: { text: "" } }, cids: ["n.7"] });
  assert.deepEqual(await probe.status("rasterprobe.input"), { focused: true, transactions: 1, preedit: { text: "" }, actions: [{ type: "insert", text: "a" }], errors: [],
    log: [{ sequence: 1, cids: ["n.7"], actions: [{ type: "insert", text: "a" }], preedit: { text: "" }, errors: [], received: null, receivedCids: null, frame: null }], pointer: [], pressFocus: 0 });

  await probe.textSize(1.5);
  assert.deepEqual(probe.sent()[2].body, { operation: "textSize", factor: 1.5 });
  assert.equal((await probe.status("rasterprobe.view")).textSize, 1.5);

  await probe.answer({ event: "connection", connected: false, reason: "restart limit" });
  assert.deepEqual(await probe.status("rasterprobe.session"), { session: null, connected: false, failure: "restart limit", error: null });
  await probe.answer({ event: "connection", connected: true });
  assert.deepEqual(probe.sent()[3].body, { operation: "open", image: REGION, textSize: 1.5 });
  await probe.fail("output closed: signal 9");
  assert.equal((await probe.status("rasterprobe.session")).failure, "output closed: signal 9");
  await probe.view.close();
});

test("the probe shows a refused request of the sidecar and records it as an error of the view", { timeout: 5000 }, async () => {
  const probe = await openProbe("raster-probe-fixture-refused-request");
  await probe.answer({ error: "imageAttached", reason: "surface tab-9 holds image raster" });
  assert.equal((await probe.status("rasterprobe.session")).error, "imageAttached: surface tab-9 holds image raster");
  probe.imageEvent({ type: "error", reason: "size" });
  await turn();
  assert.deepEqual(probe.errors(), ["rasterprobe: imageAttached: surface tab-9 holds image raster", "rasterprobe: image raster: size"]);
  await probe.view.close();
});

test("the probe logs each input transaction with the body that the sidecar echoed once, and clears its log on command", { timeout: 5000 }, async () => {
  const probe = await openProbe("raster-probe-fixture-input-log");
  const input = () => probe.status("rasterprobe.input");
  probe.imageEvent({ type: "input", actions: [{ type: "insert", text: "가" }], preedit: null, errors: [], cids: ["n.1"] });
  probe.imageEvent({ type: "input", actions: [], preedit: { text: "ㄴ" }, errors: [] });
  await turn();
  assert.deepEqual(probe.sent().slice(1).map(({ body, cids }) => [body.sequence, cids]), [[1, ["n.1"]], [2, []]]);
  const echoed = { operation: "input", sequence: 1, actions: [{ type: "insert", text: "가" }], preedit: null };
  await probe.answer({ event: "input", received: echoed });
  assert.deepEqual((await input()).log.map(({ sequence, received }) => [sequence, received]), [[1, echoed], [2, null]]);
  await probe.answer({ event: "input", received: echoed });
  await probe.answer({ event: "input", received: { sequence: 9 } });
  assert.deepEqual(probe.errors(), ["rasterprobe: the sidecar answered input 1 twice", "rasterprobe: the sidecar answered input 9, which the log does not hold"]);

  for (let index = 0; index < INPUT_LOG_LIMIT + 3; index++) probe.imageEvent({ type: "input", actions: [], preedit: null, errors: [] });
  const full = await input();
  assert.equal(full.log.length, INPUT_LOG_LIMIT);
  assert.equal(full.log[0].sequence, 6, "the log keeps the last transactions in order");
  await probe.view.run("rasterprobe.input.clear", {});
  const cleared = await input();
  assert.deepEqual([cleared.log, cleared.pointer, cleared.transactions], [[], [], INPUT_LOG_LIMIT + 5]);
  await probe.view.close();
});

test("each logged transaction keeps the cids of the answer of the sidecar and the identity of the frame that presents it", { timeout: 5000 }, async () => {
  const probe = await openProbe("raster-probe-fixture-transaction-cids");
  const input = () => probe.status("rasterprobe.input");
  const transaction = (cids) => probe.imageEvent({ type: "input", actions: [], preedit: { text: "ㅎ" }, errors: [], cids });
  transaction(["n.1"]);
  transaction(["n.2"]);
  const received = (sequence) => ({ operation: "input", sequence, actions: [], preedit: { text: "ㅎ" } });
  await probe.answer({ event: "input", received: received(1) }, ["n.1"]);
  await probe.answer({ event: "input", received: received(2) }, ["n.2"]);
  assert.deepEqual((await input()).log.map(({ receivedCids, frame }) => [receivedCids, frame]), [[["n.1"], null], [["n.2"], null]]);
  // One frame presents both inputs that the sidecar handled while its frame before was in flight.
  await probe.answer({ event: "frame", generation: 3, raster: 2, sequence: 7, inputs: [1, 2] });
  assert.deepEqual((await input()).log.map(({ frame }) => frame), [{ generation: 3, raster: 2, sequence: 7 }, { generation: 3, raster: 2, sequence: 7 }]);
  assert.deepEqual(probe.errors(), []);

  transaction(["n.3"]);
  await probe.answer({ event: "frame", generation: 3, raster: 2, sequence: 8, inputs: [3] });
  assert.deepEqual((await input()).log[2].frame, { generation: 3, raster: 2, sequence: 8 });
  await probe.answer({ event: "frame", generation: 3, raster: 2, sequence: 9, inputs: [3, 9] });
  await probe.answer({ event: "frame", generation: 3, raster: 2, sequence: 10 });
  assert.deepEqual(probe.errors(), ["rasterprobe: the sidecar presented input 3 twice", "rasterprobe: the sidecar presented input 9, which the view never sent",
    "rasterprobe: the sidecar sent frame 10 without its inputs"]);
  assert.deepEqual((await input()).log[2].frame, { generation: 3, raster: 2, sequence: 8 }, "a second presentation does not move the frame of an input");
  // An input that the log no longer holds is not attributed and is not an error.
  await probe.view.run("rasterprobe.input.clear", {});
  await probe.answer({ event: "frame", generation: 3, raster: 2, sequence: 11, inputs: [1] });
  assert.equal(probe.errors().length, 3);
  await probe.view.close();
});

test("a primary press on the region gives it the focus and the pointer list records the press", { timeout: 5000 }, async () => {
  const probe = await openProbe("raster-probe-fixture-primary-press");
  const { window } = probe.view;
  // The events of a script are never trusted; the trusted mark of a press that the platform delivers is the isTrusted of that event.
  const press = (type, button) => probe.element.dispatchEvent(new window.MouseEvent(type, { button }));
  press("pointerdown", 2);
  press("pointerdown", 0);
  press("pointerup", 0);
  await turn();
  assert.equal(probe.focuses(), 1, "only the primary press focuses the region");
  assert.deepEqual((await probe.status("rasterprobe.input")).pointer,
    [{ type: "pointerdown", button: 2, trusted: false }, { type: "pointerdown", button: 0, trusted: false }, { type: "pointerup", button: 0, trusted: false }]);
  assert.equal((await probe.status("rasterprobe.input")).pressFocus, 1, "the answer of the focus call of the press is counted");
  await probe.view.close();
});

/** The check session of the endpoint case `name`, on a client that is connected to the case player; closing the player fails when the case was not played. */
async function play(t, name) {
  const server = await startCasePlayer(name);
  const configDir = mkdtempSync(join(tmpdir(), "soksak-raster-probe-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  return { s: new Session({ name: "fixture", configDir }, client), server };
}

test("a raster probe waits for its first frame while its window draws its image regions covered, until the check ends", { timeout: 5000 }, async (t) => {
  // A check window opens behind the windows of other applications and of the other check applications, so a covered window is
  // the normal case, and the image regions of a covered window draw no raster (docs/spec/hosts.md#launch-activation).
  const { s, server } = await play(t, "raster-probe-ready");
  assert.deepEqual(await rasterReady(s, "tab-1"), { session: "s1", connected: true });
  await rasterReady(s, "tab-2");
  assert.equal(s.cleanups.length, 1, "the end of the check ends the covered drawing once");
  const covered = server.requests.filter(({ method }) => method === "diagnostics.window.draw-covered");
  assert.deepEqual(covered.map(({ params }) => params.draw), [true], "the session holds the covered drawing once");
  const requests = server.requests.map(({ method, params }) => [method, params.name]);
  assert.ok(requests.findIndex(([method]) => method === "diagnostics.window.draw-covered") < requests.findIndex(([, name]) => name === "rasterprobe.frame"),
    "the window draws covered before the wait for the frame");
  await s.cleanups[0]();
  await server.played;
  assert.deepEqual(server.requests.filter(({ method }) => method === "diagnostics.window.draw-covered").map(({ params }) => params.draw), [true, false]);
});

test("a session that a respawned service opens is a new session, also when the new service names it as the dead one did", { timeout: 1000 }, () => {
  // A service numbers its sessions from s1, so the session that a respawned service opens for the surface can have the name of
  // the session that died with the old service; the service that holds it tells the two apart (docs/spec/persistent-services.md).
  const service = (pid) => ({ pid, directory: "/config/services/sok-rasterprobe", version: "0.0.40" });
  const before = { event: "session", session: "s1", created: true, connected: true, child: 21, service: service(20), rows: 2, error: null };
  const reopened = reopenedSession(before);
  assert.equal(reopened({ ...before, rows: 0, child: 31, service: service(30) }), true, "the session of the respawned service");
  assert.equal(reopened({ ...before, session: "s2", child: 31, service: service(30) }), true, "a later session of the respawned service");
  assert.equal(reopened(before), false, "the session before the kill");
  assert.equal(reopened({ ...before, connected: false, failure: "restart" }), false, "the lost connection");
  assert.equal(reopened({ ...before, session: null, child: null, service: service(30) }), false, "a connection without a session");
  assert.equal(reopened({ ...before, connected: false, service: service(30) }), false, "a session that is not connected");
});

test("a raster probe tab that a check opens while it watches the window draws covered before the wait for its image", { timeout: 5000 }, async (t) => {
  // A check window opens behind the windows of other applications, and the image region of a covered window draws nothing, so a
  // tab opened during a capture waits for an image that never comes unless the window draws covered (docs/spec/hosts.md#launch-activation).
  const { s, server } = await play(t, "raster-probe-present-tab");
  assert.equal(await presentRasterTab(s, "card-1"), "tab-7");
  await server.played;
  const [first] = server.requests;
  assert.deepEqual([first.method, first.params.name, first.params.params], ["command.run", "core.card.add-tab", { card: "card-1", plugin: "rasterprobe" }]);
  const covered = server.requests.findIndex(({ method, params }) => method === "diagnostics.window.draw-covered" && params.draw === true);
  const image = server.requests.findIndex(({ method, params }) => method === "status.get" && params.name === "host.window");
  assert.ok(covered >= 0 && covered < image, `the window draws covered before the wait for the image: ${JSON.stringify(server.requests.map(({ method, params }) => [method, params.name]))}`);
});
