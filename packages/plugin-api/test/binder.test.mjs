// UI 요소가 선언된 명령에 연결되고, audit 가 연결되지 않은 조작 요소를 찾는지 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { commandOf, createBinder, createExpose, declarationMap } from "@soksak/plugin-api";

const { window } = new JSDOM("<body></body>", { url: "https://example.test/" });
const { document } = window;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const event = (type) => new window.Event(type, { bubbles: true });

const DECLARED = new Set(["fixture.press", "fixture.put"]);

function binder() {
  const calls = [];
  let changes = 0;
  const made = createBinder(async (name, params) => { calls.push([name, params]); return "ran"; }, {
    check(name) { if (!DECLARED.has(name)) throw new Error(`command ${name} is not declared`); },
    changed: () => { changes++; },
  });
  return { ...made, calls, changes: () => changes };
}

const element = (tag, expose) => {
  const el = document.createElement(tag);
  if (expose) el.dataset.expose = expose;
  return el;
};

test("bind marks the element and runs the command on its event", async () => {
  const b = binder();
  let id = "first";
  const fixed = b.bind(element("button"), "fixture.press", { id: "a" });
  const computed = b.bind(element("button"), "fixture.press", () => ({ id }));
  const keyed = b.bind(element("input"), "fixture.put", (e) => ({ text: e.key }),
    { event: "keydown", when: (e) => e.key === "Enter" });
  assert.deepEqual(JSON.parse(fixed.dataset.params), { id: "a" });
  assert.equal(computed.dataset.params, undefined);
  fixed.click();
  id = "second";
  computed.click();
  keyed.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a" }));
  keyed.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  await settle();
  assert.deepEqual(b.calls, [
    ["fixture.press", { id: "a" }], ["fixture.press", { id: "second" }], ["fixture.put", { text: "Enter" }],
  ]);
  assert.equal(b.changes(), 3);
});

test("bind reports a failed run to failed", async () => {
  const errors = [];
  const b = createBinder(() => Promise.reject(new Error("no")), { check() {} });
  b.bind(element("button"), "fixture.press", {}, { failed: (error) => errors.push(error.message) }).click();
  await settle();
  assert.deepEqual(errors, ["no"]);
});

test("run executes a declared command and rejects an undeclared one", async () => {
  const b = binder();
  assert.equal(await b.run("fixture.press", { id: "r" }), "ran");
  assert.deepEqual(b.calls, [["fixture.press", { id: "r" }]]);
  assert.throws(() => b.run("fixture.absent"), /fixture.absent is not declared/);
  assert.equal(b.calls.length, 1);
});

test("binding or marking an undeclared command throws", () => {
  const b = binder();
  assert.throws(() => b.bind(element("button"), "fixture.absent"), /fixture.absent is not declared/);
  assert.throws(() => b.mark(element("button"), "fixture.absent"), /fixture.absent is not declared/);
});

test("delegate runs clicks, changes, and live inputs of marked descendants", async () => {
  const b = binder();
  const root = element("div");
  const press = b.mark(element("button"), "fixture.press", { id: "b" });
  const field = b.mark(element("input"), "fixture.put", { key: "k" }, "text");
  const live = b.mark(element("input"), "fixture.put", { key: "live" }, "text");
  live.dataset.live = "";
  root.append(press, field, live);
  b.delegate(root);
  press.click();
  field.value = "typed";
  field.dispatchEvent(event("input"));
  field.dispatchEvent(event("change"));
  live.value = "now";
  live.dispatchEvent(event("input"));
  field.click();
  await settle();
  assert.deepEqual(b.calls, [
    ["fixture.press", { id: "b" }],
    ["fixture.put", { key: "k", text: "typed" }],
    ["fixture.put", { key: "live", text: "now" }],
  ], "an input without data-live runs on change only, and a click on an input runs nothing");
});

test("delegate leaves an element bound to its own event to that binding", async () => {
  const b = binder();
  const root = element("div");
  // 주소창처럼 Enter 로 실행하는 입력. WebKit 은 텍스트 입력의 Enter 에 change 도 보낸다.
  const address = b.bind(element("input"), "fixture.put", () => ({ text: address.value }),
    { event: "keydown", when: (e) => e.key === "Enter" });
  const button = b.bind(element("button"), "fixture.press", { id: "c" });
  root.append(address, button);
  b.delegate(root);
  address.value = "typed";
  address.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  address.dispatchEvent(event("change"));
  button.click();
  await settle();
  assert.deepEqual(b.calls, [["fixture.put", { text: "typed" }], ["fixture.press", { id: "c" }]],
    "a bound element ran its command again through the delegated root");
});

test("audit recognizes delegated controls inside a shadow root", async () => {
  const b = binder();
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const button = b.mark(element("button", "fixture.press"), "fixture.press");
  shadow.append(button);
  b.delegate(shadow);
  assert.deepEqual(b.audit(shadow), []);
  button.click();
  await settle();
  assert.deepEqual(b.calls, [["fixture.press", {}]]);
});

test("commandOf reads the element's command and adds the value under its parameter name", () => {
  const b = binder();
  const box = b.mark(element("input"), "fixture.put", { key: "k" });
  assert.deepEqual(commandOf(box, true), { name: "fixture.put", params: { key: "k", value: true } });
  assert.equal(commandOf(element("span")), null);
});

test("audit lists interactive elements without a command binding or a dom name", () => {
  const b = binder();
  const root = element("div");
  const delegated = element("div");
  root.append(delegated);
  b.delegate(delegated);
  const good = [
    b.bind(element("button", "x.bound"), "fixture.press"),
    b.mark(element("select", "x.delegated"), "fixture.put"),
  ];
  delegated.append(good[1]);
  const markedOutside = b.mark(element("button", "x.outside"), "fixture.press");
  const unnamed = b.bind(element("textarea"), "fixture.put");
  const plain = element("span", "x.role");
  plain.setAttribute("role", "button");
  plain.textContent = "Go";
  const editable = element("div", "x.edit");
  editable.setAttribute("contenteditable", "true");
  const inert = element("div");
  inert.setAttribute("contenteditable", "false");
  root.append(good[0], markedOutside, unnamed, plain, editable, inert);
  assert.deepEqual(b.audit(root), [
    { tag: "button", expose: "x.outside", command: null, text: "" },
    { tag: "textarea", expose: null, command: "fixture.put", text: "" },
    { tag: "span", expose: "x.role", command: null, text: "Go" },
    { tag: "div", expose: "x.edit", command: null, text: "" },
  ]);
});

test("the page expose binds only commands declared for the page and runs registered ones", async () => {
  const handlers = [];
  const port = { onRequest: async (fn) => handlers.push(fn), reply() {}, register: async () => {} };
  const declared = declarationMap({
    status: [],
    commands: [{ name: "fixture.press", description: "Press.", params: { type: "object", properties: { id: { type: "string" } } }, result: {} }],
    dom: [],
  });
  const expose = createExpose(port, async () => declared);
  const ran = [];
  await expose.command("fixture.press", (params) => { ran.push(params); });
  let changes = 0;
  expose.onBinding(() => { changes++; });
  const button = await expose.bind(element("button", "fixture.button"), "fixture.press", { id: "p" });
  await assert.rejects(expose.bind(element("button"), "fixture.absent"), /fixture.absent is not declared/);
  button.click();
  await settle();
  assert.deepEqual(ran, [{ id: "p" }]);
  assert.equal(changes, 1);
  const root = element("div");
  root.append(button);
  assert.deepEqual(expose.audit(root), []);
});
