import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPOSURE_ERRORS, actOn, createExpose, declarationMap, exposureEntries, matchesSchema, pagePackage,
  mergeExposes, replyPayload, validateInstalledPlugins, validateDiagnostics, validateExposes, validateExposureFile,
  validateManifest,
} from "../index.js";

const exposes = () => ({
  status: [{ name: "probe.lines", description: "Lines.", schema: { type: "array", items: { type: "string" } } }],
  commands: [{
    name: "probe.send", description: "Sends.",
    params: { type: "object", properties: { data: { type: "string" } } }, result: { type: "null" },
  }],
  dom: [
    { name: "probe.input", description: "Input." },
    { name: "probe.row", description: "Rows.", many: true },
  ],
});

const page = {
  id: "probe", name: "Probe", description: "검사용 플러그인.", mark: "p", icon: "<path/>",
  surface: { module: "ui/probe.js", composition: { kind: "dom" } },
};

test("exposes with the three kinds are accepted in a manifest and in a core file", () => {
  assert.equal(validateManifest({ ...page, exposes: exposes() }).exposes.dom[1].many, true);
  assert.deepEqual(validateExposes("probe", {}), {});
  const shared = exposes();
  shared.dom[0].name = "probe.lines";
  assert.equal(validateExposes("probe", shared), shared, "a status and a dom entry may share a name");
  const slow = exposes();
  slow.commands[0].timeout = 600000;
  assert.equal(validateExposes("probe", slow).commands[0].timeout, 600000, "a command may declare how long its reply takes");
  const core = { exposes: { status: [{ name: "core.value", description: "Value.", schema: {} }] } };
  assert.equal(validateExposureFile(core), core);
});

test("exposes are rejected for each invalid field", () => {
  const cases = [
    [(e) => { e.status[0].name = "other.lines"; }, /must be probe.<name>/],
    [(e) => { e.status[0].name = "probe.Lines"; }, /lowercase/],
    [(e) => { e.status[0].name = "probe."; }, /lowercase/],
    [(e) => { e.status[0].name = "probe.a_b"; }, /lowercase/],
    [(e) => { e.dom[0].name = "probe.row"; }, /duplicate dom probe.row/],
    [(e) => { e.status[0].description = ""; }, /description is required/],
    [(e) => { delete e.status[0].schema; }, /schema is required/],
    [(e) => { e.status[0].schema.minItems = 1; }, /unknown field minItems/],
    [(e) => { e.status[0].schema.items = { type: "text" }; }, /unknown schema type/],
    [(e) => { e.status[0].schema = { enum: [] }; }, /non-empty array/],
    [(e) => { delete e.commands[0].result; }, /result is required/],
    [(e) => { e.commands[0].params = { type: "string" }; }, /params must be an object schema/],
    [(e) => { e.dom[0].many = "yes"; }, /many must be a boolean/],
    [(e) => { e.commands[0].timeout = 0; }, /timeout must be an integer from 1 to 600000/],
    [(e) => { e.commands[0].timeout = 600001; }, /timeout must be an integer/],
    [(e) => { e.commands[0].timeout = 1.5; }, /timeout must be an integer/],
    [(e) => { e.status[0].timeout = 10; }, /unknown field timeout/],
    [(e) => { e.dom[0].schema = {}; }, /unknown field schema/],
    [(e) => { e.events = []; }, /unknown field events/],
    [(e) => { e.dom = {}; }, /dom must be an array/],
  ];
  for (const [change, message] of cases) {
    const value = exposes();
    change(value);
    assert.throws(() => validateExposes("probe", value), message);
  }
  assert.throws(() => validateExposes("Probe", {}), /invalid owner/);
  assert.throws(() => validateManifest({ id: "probe", name: "Probe", description: "검사용 플러그인.", sections: [{ id: "probe.list", name: "List", module: "ui/list.js" }], exposes: exposes() }),
    /exposes require a surface/);
  assert.throws(() => validateExposureFile({ exposes: exposes() }), /must be core.<name>/);
  assert.throws(() => validateExposureFile({ exposes: {}, extra: 1 }), /unknown field extra/);
});

test("a surface drop names a command declared in the manifest's exposes", () => {
  const dropping = { ...page, surface: { ...page.surface, drop: "probe.send" }, exposes: exposes() };
  assert.equal(validateManifest(dropping).surface.drop, "probe.send");
  assert.throws(() => validateManifest({ ...dropping, surface: { ...page.surface, drop: "probe.missing" } }),
    /surface drop must name a command declared in exposes/);
  assert.throws(() => validateManifest({ ...dropping, surface: { ...page.surface, drop: 1 } }),
    /surface drop must name a command declared in exposes/);
  assert.throws(() => validateManifest({ ...page, surface: { ...page.surface, drop: "probe.send" } }),
    /surface drop must name a command declared in exposes/);
});

test("a schema subset checks type, properties, items, and enum", () => {
  const schema = { type: "object", properties: { n: { type: "integer" }, mode: { enum: ["a", "b"] } } };
  assert.equal(matchesSchema(schema, { n: 1, mode: "a", other: true }), true);
  assert.equal(matchesSchema(schema, { n: 1.5 }), false);
  assert.equal(matchesSchema(schema, { mode: "c" }), false);
  assert.equal(matchesSchema(schema, []), false);
  assert.equal(matchesSchema({ type: ["string", "null"] }, null), true);
  assert.equal(matchesSchema({ items: { type: "number" } }, [1, "2"]), false);
  assert.equal(matchesSchema({}, undefined), true);
});

test("the package of a staged page is read from its path", () => {
  assert.equal(pagePackage("/modules/@scope/plugin-probe/ui/probe.html"), "@scope/plugin-probe");
  assert.equal(pagePackage("/modules/plugin-probe/probe.html"), "plugin-probe");
  assert.equal(pagePackage("/overlay.html"), null);
});

/** jsdom 없이 요소 하나를 흉내 낸다. 이벤트 생성자는 요소의 문서에서 읽는다. */
function element(rect = { left: 1, top: 2, width: 3, height: 4 }) {
  class Event { constructor(type, init) { this.type = type; this.init = init; } }
  class KeyboardEvent extends Event {}
  class MouseEvent extends Event {}
  const events = [];
  return {
    events,
    clicks: 0,
    value: "",
    dataset: {},
    isConnected: true,
    ownerDocument: { defaultView: { Event, KeyboardEvent, MouseEvent } },
    getBoundingClientRect: () => rect,
    click() { this.clicks++; },
    dispatchEvent(event) { events.push(event); return true; },
  };
}

test("registered entries answer requests and reject undeclared or unregistered names", async () => {
  const entries = exposureEntries(declarationMap(exposes()));
  assert.throws(() => entries.status("probe.other", () => 1, () => {}), /not declared/);
  assert.throws(() => entries.command("probe.lines", () => {}), /command probe.lines is not declared/);
  const code = async (work) => (await replyPayload(work)).error?.code;
  assert.equal(await code(() => entries.answer("status.get", { name: "probe.lines" })), EXPOSURE_ERRORS.unregistered);
  assert.equal(await code(() => entries.answer("status.get", { name: "probe.none" })), EXPOSURE_ERRORS.unknownName);
  assert.equal(await code(() => entries.answer("command.run", { name: "probe.lines" })), EXPOSURE_ERRORS.unknownName);
  assert.equal(await code(() => entries.answer("dom.rect", { name: "probe.input" })), EXPOSURE_ERRORS.unregistered);
  assert.equal(await code(() => entries.answer("dom.move", { name: "probe.input" })), EXPOSURE_ERRORS.unknownMethod);
  assert.equal(await code(() => entries.answer("status.get", {})), EXPOSURE_ERRORS.invalidParams);

  const sent = [];
  entries.command("probe.send", ({ data }) => {
    if (data === "fail") throw new Error("refused");
    sent.push(data);
  });
  assert.deepEqual(await replyPayload(() => entries.answer("command.run", { name: "probe.send", params: { data: "x" } })),
    { result: null });
  // command.run 은 params 를 반드시 담는다. 빈 매개변수로 바꾸어 실행하지 않는다.
  assert.equal(await code(() => entries.answer("command.run", { name: "probe.send" })), EXPOSURE_ERRORS.invalidParams);
  assert.deepEqual(sent, ["x"]);
  assert.equal(await code(() => entries.answer("command.run", { name: "probe.send", params: { data: 1 } })),
    EXPOSURE_ERRORS.invalidParams);
  assert.deepEqual(await replyPayload(() => entries.answer("command.run", { name: "probe.send", params: { data: "fail" } })),
    { error: { code: EXPOSURE_ERRORS.failed, message: "refused" } });
  assert.deepEqual(sent, ["x"]);
  assert.throws(() => entries.command("probe.send", () => {}), /already registered/);
});

test("a dom entry resolves one element, or one of many by index, and acts on it", async () => {
  const entries = exposureEntries(declarationMap(exposes()));
  const input = element();
  const rows = [element({ left: 0, top: 0, width: 1, height: 1 }), element({ left: 0, top: 5, width: 1, height: 1 })];
  entries.dom("probe.input", () => [input]);
  assert.throws(() => entries.dom("probe.input", () => [input]), /already registered/);
  entries.dom("probe.row", () => [rows[0]]);
  entries.dom("probe.row", () => [rows[1]]);
  assert.equal(entries.registered("dom", "probe.row"), true);
  assert.deepEqual(await entries.answer("dom.rect", { name: "probe.input" }), { x: 1, y: 2, width: 3, height: 4 });
  assert.equal((await entries.answer("dom.rect", { name: "probe.row", index: 1 })).y, 5);
  await assert.rejects(entries.answer("dom.rect", { name: "probe.row", index: 2 }), /no element at index 2/);

  await entries.answer("dom.act", { name: "probe.input", action: "click" });
  assert.equal(input.clicks, 1);
  await entries.answer("dom.act", { name: "probe.input", action: "input", value: "typed" });
  assert.equal(input.value, "typed");
  assert.deepEqual(input.events.map((e) => [e.type, e.init.bubbles]), [["input", true], ["change", true]]);
  await entries.answer("dom.act", { name: "probe.input", action: "dispatch", event: { type: "keydown", key: "Enter" } });
  const key = input.events.at(-1);
  assert.equal(key.constructor.name, "KeyboardEvent");
  assert.equal(key.init.key, "Enter");
  assert.equal(actOn(input, { action: "dispatch", event: { type: "mousedown", bubbles: false } }), null);
  assert.equal(input.events.at(-1).constructor.name, "MouseEvent");
  assert.equal(input.events.at(-1).init.bubbles, false);
  assert.throws(() => actOn(input, { action: "hover" }), /unknown action/);
  input.isConnected = false;
  assert.equal(entries.registered("dom", "probe.input"), false, "a removed element is no longer registered");
});

test("a watched status reports each changed value once and ends with unwatch", async () => {
  const entries = exposureEntries(declarationMap(exposes()));
  let value = ["a"];
  let emit = null;
  let stopped = 0;
  entries.status("probe.lines", () => value, (fn) => { emit = fn; return () => { stopped++; }; });
  const changes = [];
  const changed = (name, v) => changes.push([name, v]);
  assert.deepEqual(await entries.answer("status.get", { name: "probe.lines" }), ["a"]);
  assert.equal(await entries.answer("status.watch", { name: "probe.lines" }, changed), null);
  assert.equal(await entries.answer("status.watch", { name: "probe.lines" }, changed), null, "a second watch is the same watch");
  assert.deepEqual(await entries.answer("status.next", { name: "probe.lines", version: 0 }), { version: 1, value: ["a"] });
  // status.next 는 version 을 반드시 담는다. 없는 version 을 0 으로 보지 않는다.
  assert.equal((await replyPayload(() => entries.answer("status.next", { name: "probe.lines" }))).error?.code,
    EXPOSURE_ERRORS.invalidParams);
  const next = entries.answer("status.next", { name: "probe.lines", version: 1 });
  emit(["a"]);
  value = ["a", "b"];
  emit(value);
  assert.deepEqual(await next, { version: 2, value: ["a", "b"] });
  assert.deepEqual(changes, [["probe.lines", ["a"]], ["probe.lines", ["a", "b"]]]);
  const pending = entries.answer("status.next", { name: "probe.lines", version: 2 });
  await entries.answer("status.unwatch", { name: "probe.lines" });
  assert.deepEqual(await pending, { closed: true });
  assert.equal(stopped, 1);
  emit(["c"]);
  assert.equal(changes.length, 2, "an unwatched status reports nothing");
});

test("a surface page registers declared names once through its port and answers forwarded requests", async () => {
  const registered = [];
  const replies = [];
  let request = null;
  const port = {
    register: async (kind, name) => { registered.push([kind, name]); },
    onRequest: async (fn) => { request = fn; },
    reply: (id, payload) => { replies.push([id, payload]); },
  };
  let loads = 0;
  const declared = exposes();
  declared.dom[0].name = "probe.lines";
  const expose = createExpose(port, async () => { loads++; return declared; });
  await expose.command("probe.send", ({ data }) => data.length);
  const rows = [element(), element()];
  await expose.dom("probe.row", rows[0]);
  await expose.dom("probe.row", rows[1]);
  await assert.rejects(expose.status("probe.unknown", () => 1, () => {}), /not declared/);
  await expose.status("probe.lines", () => [], () => () => {});
  await expose.dom("probe.lines", element());
  assert.equal(loads, 1);
  assert.deepEqual(registered, [["command", "probe.send"], ["dom", "probe.row"], ["status", "probe.lines"], ["dom", "probe.lines"]],
    "the same name registers once per kind");
  assert.equal(rows[1].dataset.expose, "probe.row");

  request({ id: 7, method: "command.run", params: { name: "probe.send", params: { data: "abc" } } });
  request({ id: 8, method: "dom.rect", params: { name: "probe.row", index: 1 } });
  request({ id: 9, method: "status.get", params: { name: "probe.missing" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replies.sort((a, b) => a[0] - b[0]), [
    [7, { result: 3 }],
    [8, { result: { x: 1, y: 2, width: 3, height: 4 } }],
    [9, { error: { code: EXPOSURE_ERRORS.unknownName, message: "unknown status probe.missing" } }],
  ]);
});

test("a rejected stale exposure reply is reported instead of becoming an unhandled promise", async () => {
  const reports = [];
  let request;
  const port = {
    register: async () => {},
    onRequest: async (fn) => { request = fn; },
    reply: async () => { throw new Error("exposure reply 11928 has no matching request"); },
    report: async (message) => { reports.push(message); },
  };
  const expose = createExpose(port, async () => exposes());
  await expose.command("probe.send", ({ data }) => data.length);
  request({ id: 11928, method: "command.run", params: { name: "probe.send", params: { data: "abc" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reports, ["exposure reply 11928: exposure reply 11928 has no matching request"]);
});

test("diagnostic declarations extend a surface plugin once and are rejected otherwise", () => {
  const manifest = { ...page, exposes: exposes() };
  const inject = {
    name: "probe.inject", description: "Injects.", params: { type: "object", properties: {} }, result: { type: "null" },
  };
  const diagnostics = { module: "ui/probe-diagnostics.js", exposes: { commands: [inject] } };
  assert.equal(validateDiagnostics(manifest, diagnostics), diagnostics);
  assert.deepEqual(mergeExposes(manifest.exposes, diagnostics.exposes).commands.map((entry) => entry.name),
    ["probe.send", "probe.inject"]);
  assert.throws(() => validateDiagnostics(manifest, { ...diagnostics, exposes: { commands: [manifest.exposes.commands[0]] } }),
    /command probe\.send is declared twice/);
  assert.throws(() => validateDiagnostics({ id: "probe", name: "Probe", description: "검사용 플러그인.", sections: [] }, diagnostics), /diagnostics require a surface/);
  assert.throws(() => validateDiagnostics(manifest, { ...diagnostics, module: "../probe.js" }), /module must be a JavaScript path/);
  assert.throws(() => validateDiagnostics(manifest, { ...diagnostics, extra: true }), /extra/);
  assert.throws(() => validateDiagnostics(manifest, { module: "ui/probe-diagnostics.js", exposes: { commands: [{ ...inject, name: "other.inject" }] } }),
    /must be probe\.<name>/);

});

test("the installed plugin document lists plugins with their manifests and diagnostics and reports the host's error", () => {
  const plugins = [
    { id: "alpha", package: "plugin-alpha", version: "1.0.0", manifest: { id: "alpha", name: "Alpha", description: "검사용.", sections: [{ id: "alpha.list", name: "List", module: "ui/list.js" }] } },
    { id: "probe", package: "@fixture/probe", version: "0.1.0", manifest: { id: "probe", name: "Probe", description: "검사용.", sections: [{ id: "probe.list", name: "List", module: "ui/list.js" }] },
      diagnostics: { module: "ui/d.js", exposes: {} } },
  ];
  assert.equal(validateInstalledPlugins({ plugins }), plugins);
  assert.deepEqual(validateInstalledPlugins({ plugins: [] }), []);
  assert.throws(() => validateInstalledPlugins({ error: "plugins/installed.json: format must be 1" }),
    /^Error: installed plugins: plugins\/installed.json: format must be 1$/);
  assert.throws(() => validateInstalledPlugins({ plugins: [plugins[0], plugins[0]] }), /plugin alpha appears twice/);
  assert.throws(() => validateInstalledPlugins({ plugins: [{ ...plugins[0], package: "Bad" }] }), /package must be a package name/);
  assert.throws(() => validateInstalledPlugins({ plugins: [{ ...plugins[0], extra: 1 }] }), /unknown field extra/);
  assert.throws(() => validateInstalledPlugins({ plugins: [{ ...plugins[1], diagnostics: [] }] }), /diagnostics must be an object/);
  assert.throws(() => validateInstalledPlugins([]), /expected an object/);
  const { manifest: _, ...unlisted } = plugins[0];
  assert.throws(() => validateInstalledPlugins({ plugins: [unlisted] }), /plugin alpha manifest is required/);
  assert.throws(() => validateInstalledPlugins({ plugins: [{ ...plugins[0], manifest: { ...plugins[0].manifest, id: "beta" } }] }),
    /plugin alpha has a plugin.json with id beta/);
  assert.throws(() => validateInstalledPlugins({ plugins: [{ ...plugins[0], manifest: { id: "alpha" } }] }), /name/);
});
