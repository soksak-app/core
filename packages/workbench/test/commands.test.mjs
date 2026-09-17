// UI 요소가 명령을 가리키고, 누름과 값 입력이 그 명령을 실행하는지 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { registry } = await import("../exposure.js");
const { audit, bind, commandOf, delegate, mark, run } = await import("../commands.js");

registry.declare("core", {
  status: [],
  commands: [
    { name: "core.fixture.press", description: "Press.", params: { type: "object", properties: { id: { type: "string" } } }, result: {} },
    { name: "core.fixture.put", description: "Put.", params: { type: "object", properties: { key: { type: "string" }, text: { type: "string" } } }, result: {} },
  ],
  dom: [],
});
const calls = [];
registry.command("core.fixture.press", (params) => { calls.push(["press", params]); return "pressed"; });
registry.command("core.fixture.put", (params) => { calls.push(["put", params]); });

const settle = () => new Promise((resolve) => setImmediate(resolve));
const event = (type) => new dom.window.Event(type, { bubbles: true });

test("bind marks the element and runs the command with its parameters on click", async () => {
  calls.length = 0;
  const button = bind(document.createElement("button"), "core.fixture.press", { id: "a" });
  document.body.append(button);
  assert.equal(button.dataset.command, "core.fixture.press");
  assert.deepEqual(JSON.parse(button.dataset.params), { id: "a" });
  button.click();
  await settle();
  assert.deepEqual(calls, [["press", { id: "a" }]]);
});

test("bind with a parameter function computes the parameters when the element is used", async () => {
  calls.length = 0;
  let id = "first";
  const button = bind(document.createElement("button"), "core.fixture.press", () => ({ id }));
  assert.equal(button.dataset.params, undefined);
  id = "second";
  button.click();
  await settle();
  assert.deepEqual(calls, [["press", { id: "second" }]]);
});

test("delegate runs clicks, changes, and live inputs of marked descendants with their values", async () => {
  calls.length = 0;
  const root = document.createElement("div");
  const press = mark(document.createElement("button"), "core.fixture.press", { id: "b" });
  const field = mark(document.createElement("input"), "core.fixture.put", { key: "k" }, "text");
  const live = mark(document.createElement("input"), "core.fixture.put", { key: "live" }, "text");
  live.dataset.live = "";
  root.append(press, field, live);
  document.body.append(root);
  delegate(root);
  press.click();
  field.value = "typed";
  field.dispatchEvent(event("input"));
  field.dispatchEvent(event("change"));
  live.value = "now";
  live.dispatchEvent(event("input"));
  field.click();
  await settle();
  assert.deepEqual(calls, [
    ["press", { id: "b" }],
    ["put", { key: "k", text: "typed" }],
    ["put", { key: "live", text: "now" }],
  ], "an input without data-live runs on change only, and a click on an input runs nothing");
});

test("commandOf reads the element's command and adds the value under its parameter name", () => {
  const box = mark(document.createElement("input"), "core.fixture.put", { key: "k" });
  assert.deepEqual(commandOf(box, true), { name: "core.fixture.put", params: { key: "k", value: true } });
  assert.equal(commandOf(document.createElement("span")), null);
});

test("binding an undeclared command throws, and audit finds unbound controls", () => {
  assert.throws(() => bind(document.createElement("button"), "core.fixture.absent"), /core.fixture.absent is not declared/);
  const root = document.createElement("div");
  const named = bind(document.createElement("button"), "core.fixture.press");
  named.dataset.expose = "core.fixture.named";
  const loose = document.createElement("button");
  loose.dataset.expose = "core.fixture.loose";
  root.append(named, loose);
  assert.deepEqual(audit(root), [{ tag: "button", expose: "core.fixture.loose", command: null, text: "" }]);
});

test("run rejects undeclared commands and invalid parameters", async () => {
  await assert.rejects(run("core.fixture.absent"), /unknown command core.fixture.absent/);
  await assert.rejects(run("core.fixture.press", { id: 3 }), /invalid params/);
  assert.equal(await run("core.fixture.press", { id: "c" }), "pressed");
});
