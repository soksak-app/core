// The raster probe and its fake persistent sidecar replace the terminal and its sidecars as the vehicles of the core checks of
// image regions, frames and persistent sidecar services (docs/spec/plugin-processes.md#verification-boundaries). These tests hold
// the declarations that the applications read and the view logic of the probe without a window; the frames and the service run in
// the window checks.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateManifest, validateSidecar } from "@soksak/plugin-api";

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

/** A fake view bridge and exposure that record what the probe registers and sends. */
function fakeView({ textSize = 1.25, held = null, textSizeAtOnce = false } = {}) {
  const sent = [];
  // The order of the calls of the view: each request by its operation, the composition, the text size listener and each command.
  const order = [];
  const errors = [];
  const commands = new Map();
  const statuses = new Map();
  const imageHandlers = new Map();
  let answer;
  let failure;
  let onTextSize;
  let observed;
  const listeners = new Map();
  const element = {
    getBoundingClientRect: () => ({ width: 400, height: 300, left: 0, top: 24 }),
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  const bridge = {
    runtime: {
      sidecar: (name) => {
        assert.equal(name, SIDECAR);
        return {
          on: async (surface, listener) => { assert.equal(surface, "tab-9"); answer = listener; },
          onFailure: async (surface, listener) => { failure = listener; },
          send: async (surface, body, cids = []) => {
            assert.ok(answer && failure, "the view subscribes before its first request");
            sent.push({ surface, body, cids });
            order.push(`send ${body.operation}`);
          },
        };
      },
      textSize: {
        read: async () => textSize,
        on: async (listener) => {
          onTextSize = listener;
          order.push("textSize.on");
          // A listener can be told the current factor as soon as it registers.
          if (textSizeAtOnce) listener(textSize);
        },
      },
      error: (where, text) => errors.push(`${where}: ${text}`),
    },
    composition: {
      create: async ({ regions }) => {
        assert.deepEqual(Object.keys(regions), [REGION]);
        order.push("composition");
        return { region: () => ({
          on: (type, fn) => {
            imageHandlers.set(type, fn);
            // attachImage holds the input events of a region until its first input handler registers, then delivers them.
            if (type === "input" && held !== null) fn(held);
          },
          focus: async () => sent.push({ focus: true }),
        }) };
      },
    },
    commands: { register: async (name, run) => { commands.set(name, run); order.push(`command ${name}`); } },
  };
  const elements = new Map();
  const expose = { status: async (name, read, subscribe) => { statuses.set(name, { read, subscribe }); },
    element: async (name, target) => { elements.set(name, target); } };
  const view = {
    sokSurface: { surface: "tab-9" },
    devicePixelRatio: 2,
    ResizeObserver: class { constructor(callback) { observed = callback; } observe() {} },
  };
  const document = { getElementById: (id) => { assert.equal(id, REGION); return element; } };
  return { bridge, expose, view, document, sent, order, errors, commands, statuses, elements, element, imageHandlers, press: (type, event) => listeners.get(type)({ type, ...event }),
    answer: (body, cids) => answer(body, cids), fail: (reason) => failure(reason), textSize: (value) => onTextSize(value), resized: () => observed() };
}

test("the probe opens its session with its image and reports the view, the session and the frames", { timeout: 1000 }, async () => {
  const fake = fakeView();
  await startRasterProbe(fake);
  const manifest = read(join(PROBE, "plugin.json"));
  assert.deepEqual([...fake.statuses.keys()], manifest.exposes.status.map(({ name }) => name));
  assert.deepEqual([...fake.commands.keys()], manifest.exposes.commands.map(({ name }) => name));
  assert.deepEqual([...fake.elements.keys()], manifest.exposes.element.map(({ name }) => name));
  assert.equal(fake.elements.get("rasterprobe.raster"), fake.element, "the element entry is the image region element");
  assert.deepEqual(fake.sent, [{ surface: "tab-9", body: { operation: "open", image: REGION, textSize: 1.25 }, cids: [] }]);
  const status = (name) => fake.statuses.get(name).read();
  assert.deepEqual(status("rasterprobe.view"), { width: 400, height: 300, left: 0, top: 24, deviceWidth: 800, deviceHeight: 600, devicePixelRatio: 2, textSize: 1.25 });
  assert.equal(status("rasterprobe.session").connected, false);

  const values = [];
  fake.statuses.get("rasterprobe.frame").subscribe((value) => values.push(value));
  fake.answer({ event: "session", session: "s1", created: true, mode: "image", rows: 0 });
  fake.answer({ event: "frame", generation: 2, raster: 5, sequence: 1, rows: 0, inputs: [] });
  assert.deepEqual(status("rasterprobe.session"), { event: "session", session: "s1", created: true, mode: "image", rows: 0, connected: true, failure: null, error: null });
  assert.deepEqual(values, [{ event: "frame", generation: 2, raster: 5, sequence: 1, rows: 0, inputs: [] }]);

  await fake.commands.get("rasterprobe.rows")({ count: 4 });
  await fake.commands.get("rasterprobe.kill")({});
  assert.deepEqual(fake.sent.slice(1).map(({ body }) => body), [{ operation: "rows", count: 4 }, { operation: "kill" }]);
  fake.answer({ event: "rows", count: 4 });
  assert.equal(status("rasterprobe.session").rows, 4);
});

test("the view opens its session before any other request, as a view of a reloaded page must", { timeout: 1000 }, async () => {
  // The region delivers a held focus transaction as soon as its input handler registers, and the text size listener is told the
  // factor at once: neither request reaches the sidecar before the open, which a surface whose session ended would refuse.
  const focus = { type: "input", actions: [{ type: "focus", focused: true }], preedit: null, errors: [], cids: ["n.1"] };
  const fake = fakeView({ held: focus, textSizeAtOnce: true });
  await startRasterProbe(fake);
  const sends = fake.order.filter((entry) => entry.startsWith("send "));
  assert.deepEqual(sends, ["send open", "send input", "send textSize"]);
  assert.equal(fake.order[0], "send open", "the open precedes the composition, the commands and the text size listener");
  assert.deepEqual(fake.sent[0].body, { operation: "open", image: REGION, textSize: 1.25 });
  assert.deepEqual(fake.sent[1], { surface: "tab-9", body: { operation: "input", sequence: 1, actions: focus.actions, preedit: null }, cids: ["n.1"] });
});

test("the probe forwards region input with its cids, follows the text size and opens again on a connection notice", { timeout: 1000 }, async () => {
  const fake = fakeView({ textSize: null });
  await startRasterProbe(fake);
  assert.equal(fake.sent[0].body.textSize, 1, "an unknown text size is factor 1");
  fake.imageHandlers.get("focus")({ type: "focus", focused: true });
  fake.imageHandlers.get("input")({ type: "input", actions: [{ type: "insert", text: "a" }], preedit: { text: "" }, errors: [], cids: ["n.7"] });
  assert.deepEqual(fake.sent[1], { surface: "tab-9", body: { operation: "input", sequence: 1, actions: [{ type: "insert", text: "a" }], preedit: { text: "" } }, cids: ["n.7"] });
  assert.deepEqual(fake.statuses.get("rasterprobe.input").read(), { focused: true, transactions: 1, preedit: { text: "" }, actions: [{ type: "insert", text: "a" }], errors: [],
    log: [{ sequence: 1, cids: ["n.7"], actions: [{ type: "insert", text: "a" }], preedit: { text: "" }, errors: [], received: null, receivedCids: null, frame: null }], pointer: [] });

  fake.textSize(1.5);
  assert.deepEqual(fake.sent[2].body, { operation: "textSize", factor: 1.5 });
  assert.equal(fake.statuses.get("rasterprobe.view").read().textSize, 1.5);

  fake.answer({ event: "connection", connected: false, reason: "restart limit" });
  assert.deepEqual(fake.statuses.get("rasterprobe.session").read(), { session: null, connected: false, failure: "restart limit", error: null });
  fake.answer({ event: "connection", connected: true });
  assert.deepEqual(fake.sent[3].body, { operation: "open", image: REGION, textSize: 1.5 });
  fake.fail("output closed: signal 9");
  assert.equal(fake.statuses.get("rasterprobe.session").read().failure, "output closed: signal 9");
});

test("the probe shows a refused request of the sidecar and records it as an error of the view", { timeout: 1000 }, async () => {
  const fake = fakeView();
  await startRasterProbe(fake);
  fake.answer({ error: "imageAttached", reason: "surface tab-9 holds image raster" });
  assert.equal(fake.statuses.get("rasterprobe.session").read().error, "imageAttached: surface tab-9 holds image raster");
  fake.imageHandlers.get("error")({ type: "error", reason: "size" });
  assert.deepEqual(fake.errors, ["rasterprobe: imageAttached: surface tab-9 holds image raster", "rasterprobe: image raster: size"]);
});

test("the probe logs each input transaction with the body that the sidecar echoed once, and clears its log on command", { timeout: 1000 }, async () => {
  const fake = fakeView();
  await startRasterProbe(fake);
  const input = () => fake.statuses.get("rasterprobe.input").read();
  fake.imageHandlers.get("input")({ type: "input", actions: [{ type: "insert", text: "가" }], preedit: null, errors: [], cids: ["n.1"] });
  fake.imageHandlers.get("input")({ type: "input", actions: [], preedit: { text: "ㄴ" }, errors: [] });
  assert.deepEqual(fake.sent.slice(1).map(({ body, cids }) => [body.sequence, cids]), [[1, ["n.1"]], [2, []]]);
  const echoed = { operation: "input", sequence: 1, actions: [{ type: "insert", text: "가" }], preedit: null };
  fake.answer({ event: "input", received: echoed });
  assert.deepEqual(input().log.map(({ sequence, received }) => [sequence, received]), [[1, echoed], [2, null]]);
  fake.answer({ event: "input", received: echoed });
  fake.answer({ event: "input", received: { sequence: 9 } });
  assert.deepEqual(fake.errors, ["rasterprobe: the sidecar answered input 1 twice", "rasterprobe: the sidecar answered input 9, which the log does not hold"]);

  for (let index = 0; index < INPUT_LOG_LIMIT + 3; index++) fake.imageHandlers.get("input")({ type: "input", actions: [], preedit: null, errors: [] });
  assert.equal(input().log.length, INPUT_LOG_LIMIT);
  assert.equal(input().log[0].sequence, 6, "the log keeps the last transactions in order");
  await fake.commands.get("rasterprobe.input.clear")({});
  assert.deepEqual([input().log, input().pointer, input().transactions], [[], [], INPUT_LOG_LIMIT + 5]);
});

test("each logged transaction keeps the cids of the answer of the sidecar and the identity of the frame that presents it", { timeout: 1000 }, async () => {
  const fake = fakeView();
  await startRasterProbe(fake);
  const input = () => fake.statuses.get("rasterprobe.input").read();
  const transaction = (cids) => fake.imageHandlers.get("input")({ type: "input", actions: [], preedit: { text: "ㅎ" }, errors: [], cids });
  transaction(["n.1"]);
  transaction(["n.2"]);
  const received = (sequence) => ({ operation: "input", sequence, actions: [], preedit: { text: "ㅎ" } });
  fake.answer({ event: "input", received: received(1) }, ["n.1"]);
  fake.answer({ event: "input", received: received(2) }, ["n.2"]);
  assert.deepEqual(input().log.map(({ receivedCids, frame }) => [receivedCids, frame]), [[["n.1"], null], [["n.2"], null]]);
  // One frame presents both inputs that the sidecar handled while its frame before was in flight.
  fake.answer({ event: "frame", generation: 3, raster: 2, sequence: 7, inputs: [1, 2] });
  assert.deepEqual(input().log.map(({ frame }) => frame), [{ generation: 3, raster: 2, sequence: 7 }, { generation: 3, raster: 2, sequence: 7 }]);
  assert.deepEqual(fake.errors, []);

  transaction(["n.3"]);
  fake.answer({ event: "frame", generation: 3, raster: 2, sequence: 8, inputs: [3] });
  assert.deepEqual(input().log[2].frame, { generation: 3, raster: 2, sequence: 8 });
  fake.answer({ event: "frame", generation: 3, raster: 2, sequence: 9, inputs: [3, 9] });
  fake.answer({ event: "frame", generation: 3, raster: 2, sequence: 10 });
  assert.deepEqual(fake.errors, ["rasterprobe: the sidecar presented input 3 twice", "rasterprobe: the sidecar presented input 9, which the view never sent",
    "rasterprobe: the sidecar sent frame 10 without its inputs"]);
  assert.deepEqual(input().log[2].frame, { generation: 3, raster: 2, sequence: 8 }, "a second presentation does not move the frame of an input");
  // An input that the log no longer holds is not attributed and is not an error.
  await fake.commands.get("rasterprobe.input.clear")({});
  fake.answer({ event: "frame", generation: 3, raster: 2, sequence: 11, inputs: [1] });
  assert.equal(fake.errors.length, 3);
});

test("a primary press on the region gives it the focus and the pointer list records the press", { timeout: 1000 }, async () => {
  const fake = fakeView();
  await startRasterProbe(fake);
  fake.press("pointerdown", { button: 2, isTrusted: true });
  fake.press("pointerdown", { button: 0, isTrusted: true });
  fake.press("pointerup", { button: 0, isTrusted: false });
  await Promise.resolve();
  assert.deepEqual(fake.sent.filter((item) => item.focus).length, 1, "only the primary press focuses the region");
  assert.deepEqual(fake.statuses.get("rasterprobe.input").read().pointer,
    [{ type: "pointerdown", button: 2, trusted: true }, { type: "pointerdown", button: 0, trusted: true }, { type: "pointerup", button: 0, trusted: false }]);
});

test("a raster probe waits for its first frame while its window draws its image regions covered, until the check ends", { timeout: 1000 }, async () => {
  // A check window opens behind the windows of other applications and of the other check applications, so a covered window is
  // the normal case, and the image regions of a covered window draw no raster (docs/spec/hosts.md#launch-activation).
  const calls = [];
  const cleanups = [];
  const s = {
    client: { endpoint: { pid: 4242 } },
    registered: async (surface, entries) => { calls.push(["registered", surface, entries]); },
    request: async (method, params) => { calls.push(["request", method, params]); return null; },
    until: async (name, accept, _what, options) => {
      calls.push(["until", name, options]);
      const value = name === "rasterprobe.session" ? { session: "s1", connected: true } : { generation: 1, raster: 1, sequence: 1 };
      assert.ok(accept(value));
      return value;
    },
    cleanup: (run) => { cleanups.push(run); },
  };
  assert.deepEqual(await rasterReady(s, "tab-1"), { session: "s1", connected: true });
  await rasterReady(s, "tab-2");
  const covered = calls.filter(([kind]) => kind === "request");
  assert.deepEqual(covered, [["request", "diagnostics.window.draw-covered", { draw: true }]], "the session holds the covered drawing once");
  const frame = calls.findIndex(([kind, name]) => kind === "until" && name === "rasterprobe.frame");
  assert.ok(calls.findIndex(([kind]) => kind === "request") < frame, "the window draws covered before the wait for the frame");
  assert.deepEqual(calls[0], ["registered", "tab-1", RASTER_ENTRIES]);
  assert.equal(cleanups.length, 1, "the end of the check ends the covered drawing once");
  calls.length = 0;
  await cleanups[0]();
  assert.deepEqual(calls, [["request", "diagnostics.window.draw-covered", { draw: false }]]);
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

test("a raster probe tab that a check opens while it watches the window draws covered before the wait for its image", { timeout: 1000 }, async () => {
  // A check window opens behind the windows of other applications, and the image region of a covered window draws nothing, so a
  // tab opened during a capture waits for an image that never comes unless the window draws covered (docs/spec/hosts.md#launch-activation).
  const calls = [];
  const values = {
    "core.grid": { cards: [{ id: "card-1", active: "tab-7" }] },
    "core.surfaces": [{ surface: "tab-7", plugin: "rasterprobe", visible: true, exposes: [...RASTER_ENTRIES] }],
    "rasterprobe.session": { session: "s1", connected: true },
    "rasterprobe.frame": { generation: 1, raster: 1, sequence: 1 },
    "host.window": { regions: [{ surface: "tab-7", name: "raster", visible: true, presented: { generation: 1, raster: 1, sequence: 1 } }] },
  };
  const s = {
    client: { endpoint: { pid: 4242 } },
    run: async (name, params) => { calls.push(["run", name, params]); return { tab: "tab-7" }; },
    registered: async (surface, entries) => { calls.push(["registered", surface, entries]); },
    request: async (method, params) => { calls.push(["request", method, params]); return null; },
    until: async (name, accept) => {
      calls.push(["until", name]);
      assert.ok(accept(values[name]), name);
      return values[name];
    },
    get: async (name) => values[name],
    cleanup: () => {},
  };
  assert.equal(await presentRasterTab(s, "card-1"), "tab-7");
  assert.deepEqual(calls[0], ["run", "core.card.add-tab", { card: "card-1", plugin: "rasterprobe" }]);
  const covered = calls.findIndex(([kind, method, params]) => kind === "request" && method === "diagnostics.window.draw-covered"
    && params?.draw === true);
  const image = calls.findIndex(([kind, name]) => kind === "until" && name === "host.window");
  assert.ok(covered >= 0 && covered < image, `the window draws covered before the wait for the image: ${JSON.stringify(calls)}`);
});
