// Validation, drawing, and the display path of a declared UI value of a list (docs/spec/declared-ui.md).
// The rules are the ones of the rejection table, the list element, the dom names, and the binding.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body><div id=body></div></body>");
globalThis.document = dom.window.document;

// The log lines of the display path are collected through the host report function (shown-errors.js).
const reports = [];
mock.module("../host.js", { namedExports: { report: (line) => { reports.push(line); } } });

const OPTIONS = {
  owner: "demo",
  declared: (name) => name === "demo.open",
  hasIcon: (name) => name === "star",
};

const list = (items, extra = {}) => ({ elements: [{ kind: "list", key: "list1", empty: "none", items, ...extra }] });
const item = (key, extra = {}) => ({ key, label: key, ...extra });

async function load(name) {
  return import(`../declared-ui.js?${name}`);
}

function rejectionOf(value, options = OPTIONS, module) {
  try {
    module.validateValue(value, options);
  } catch (error) {
    return error;
  }
  return null;
}

test("a valid list value is accepted and its elements are returned", async () => {
  const module = await load("accept");
  const value = list([item("a", { command: "demo.open", params: { id: 1 }, icon: "star" }), item("b", { detail: "two" })]);
  assert.equal(rejectionOf(value, OPTIONS, module), null, "a valid list was rejected");
  const { elements } = module.validateValue(value, OPTIONS);
  assert.equal(elements[0].kind, "list");
  assert.equal(elements[0].items.length, 2);
});

test("a root that is not an object is rejected at the root pointer", async () => {
  const module = await load("root");
  const error = rejectionOf([], OPTIONS, module);
  assert.ok(error instanceof module.DeclaredUIRejection, "no rejection");
  assert.equal(error.pointer, "/");
  assert.equal(error.reason, "root must be an object");
});

test("a root field other than elements is rejected with its name quoted", async () => {
  const module = await load("root-field");
  const error = rejectionOf({ elements: [], extra: 1 }, OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/");
  assert.equal(error.reason, 'unknown field "extra"');
});

test("elements that is not an array is rejected at /elements", async () => {
  const module = await load("elements");
  const error = rejectionOf({ elements: {} }, OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements");
  assert.equal(error.reason, "elements must be an array");
});

test("an element without kind, and an unknown kind, are rejected at their pointers", async () => {
  const module = await load("kind");
  const missing = rejectionOf({ elements: [{ key: "x" }] }, OPTIONS, module);
  assert.ok(missing, "no rejection for the missing kind");
  assert.equal(missing.pointer, "/elements/0");
  assert.equal(missing.reason, "missing kind");
  const unknown = rejectionOf({ elements: [{ kind: "chart", key: "x" }] }, OPTIONS, module);
  assert.ok(unknown, "no rejection for the unknown kind");
  assert.equal(unknown.pointer, "/elements/0/kind");
  assert.equal(unknown.reason, 'unknown kind "chart"');
});

test("more than 1000 items is rejected at the items array", async () => {
  const module = await load("items-count");
  const items = Array.from({ length: 1001 }, (_, i) => item(`k${i}`));
  const error = rejectionOf(list(items), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/items");
  assert.equal(error.reason, "exceeds 1000 items");
});

test("an item with an unknown field is rejected at the item", async () => {
  const module = await load("item-field");
  const error = rejectionOf(list([item("a", { color: "red" })]), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/items/0");
  assert.equal(error.reason, 'unknown field "color"');
});

test("a missing list label is rejected at the item with the field quoted", async () => {
  const module = await load("missing");
  const error = rejectionOf({ elements: [{ kind: "list", key: "list1", empty: "none", items: [{ key: "a" }] }] }, OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/items/0");
  assert.equal(error.reason, 'missing "label"');
});

test("a label with a control character is rejected at the label", async () => {
  const module = await load("control");
  const error = rejectionOf(list([item("a", { label: "x\u0007y" })]), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/items/0/label");
  assert.equal(error.reason, '"label" contains a control character');
});

test("a label of 501 code points is rejected at the label", async () => {
  const module = await load("text-length");
  const error = rejectionOf(list([item("a", { label: "x".repeat(501) })]), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/items/0/label");
  assert.equal(error.reason, "exceeds 500 code points");
});

test("a key with a character outside the key rules is rejected at the key", async () => {
  const module = await load("key-pattern");
  const error = rejectionOf(list([item("a b")]), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/items/0/key");
  assert.equal(error.reason, "key must be 1 to 128 code points of A-Z, a-z, 0-9, ., _, : or -");
});

test("a repeated item key is rejected at the second key", async () => {
  const module = await load("duplicate");
  const error = rejectionOf(list([item("a"), item("a")]), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/items/1/key");
  assert.equal(error.reason, 'duplicate key "a"');
});

test("a command without an owner, of another plugin, or undeclared is rejected at the command", async () => {
  const module = await load("command");
  const noOwner = rejectionOf(list([item("a", { command: "open" })]), OPTIONS, module);
  assert.equal(noOwner?.pointer, "/elements/0/items/0/command");
  assert.equal(noOwner?.reason, 'command "open" must be named "demo.open"');
  const other = rejectionOf(list([item("a", { command: "core.open" })]), OPTIONS, module);
  assert.equal(other?.reason, 'command "core.open" is not a command of plugin "demo"');
  const undeclared = rejectionOf(list([item("a", { command: "demo.close" })]), OPTIONS, module);
  assert.equal(undeclared?.pointer, "/elements/0/items/0/command");
  assert.equal(undeclared?.reason, 'undeclared command "demo.close"');
});

test("an icon that is not in the core icon table is rejected at the icon", async () => {
  const module = await load("icon");
  const error = rejectionOf(list([item("a", { icon: "nope" })]), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/items/0/icon");
  assert.equal(error.reason, 'unknown icon "nope"');
});

test("a parameter value that is an array is rejected at the parameter value", async () => {
  const module = await load("params-type");
  const error = rejectionOf(list([item("a", { command: "demo.open", params: { ids: [1] } })]), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/items/0/params/ids");
  assert.equal(error.reason, "params values must be string, finite number, boolean or null");
});

test("more than 16 parameter keys are rejected at the params object", async () => {
  const module = await load("params-keys");
  const params = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, i]));
  const error = rejectionOf(list([item("a", { command: "demo.open", params })]), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/items/0/params");
  assert.equal(error.reason, "exceeds 16 keys");
});

test("enabled on an item without command is rejected at the item", async () => {
  const module = await load("requires-command");
  const error = rejectionOf(list([item("a", { enabled: false })]), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/items/0");
  assert.equal(error.reason, '"enabled" requires command');
});

test("a list without empty is rejected at the list", async () => {
  const module = await load("empty");
  const error = rejectionOf({ elements: [{ kind: "list", key: "list1", items: [] }] }, OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0");
  assert.equal(error.reason, 'missing "empty"');
});

test("the first row of the table wins over a later row that appears earlier in the value", async () => {
  const module = await load("row-order");
  const value = { elements: [
    { kind: "list", key: "a", empty: "x", items: [item("k"), item("k")] },
    { kind: "chart", key: "b" },
  ] };
  const error = rejectionOf(value, OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/1/kind");
  assert.equal(error.reason, 'unknown kind "chart"');
});

test("a list draws its empty text when it has no items, with no control", async () => {
  const module = await load("draw-empty");
  const body = document.createElement("div");
  module.drawValue(body, list([]).elements, { owner: "demo", bind: () => {} });
  assert.equal(body.textContent, "none", "the empty text was not drawn");
  assert.equal(body.querySelector("[data-expose]"), null, "the empty text carries a control");
});

test("an item with a command draws a bound button with the control attributes", async () => {
  const module = await load("draw-button");
  const body = document.createElement("div");
  const calls = [];
  const bind = (el, name, params, options) => { calls.push({ el, name, params, options }); return el; };
  module.drawValue(body, list([item("a", { command: "demo.open", params: { id: 1 } })]).elements, { owner: "demo", bind });
  const button = body.querySelector("button");
  assert.ok(button, "no button was drawn");
  assert.equal(button.textContent, "a");
  assert.equal(button.dataset.expose, "core.sidebar.section.control");
  assert.equal(button.dataset.key, "list1");
  assert.equal(button.dataset.path, '["a"]');
  assert.equal(button.dataset.role, "label");
  assert.equal(calls.length, 1, "the button was not bound once");
  assert.equal(calls[0].el, button);
  assert.equal(calls[0].name, "demo.open");
  assert.deepEqual(calls[0].params, { id: 1 });
  assert.deepEqual(calls[0].options, { event: "click" });
});

test("a static row carries no dom name and no control attributes", async () => {
  const module = await load("draw-static");
  const body = document.createElement("div");
  module.drawValue(body, list([item("a")]).elements, { owner: "demo", bind: () => {} });
  assert.ok(body.textContent.includes("a"), "the row label was not drawn");
  assert.equal(body.querySelector("[data-expose]"), null, "a static row carries a dom name");
  assert.equal(body.querySelector("[data-key]"), null, "a static row carries data-key");
});

test("enabled false draws the button with the disabled attribute", async () => {
  const module = await load("draw-disabled");
  const body = document.createElement("div");
  module.drawValue(body, list([item("a", { command: "demo.open", enabled: false })]).elements, { owner: "demo", bind: () => {} });
  assert.ok(body.querySelector("button").disabled, "the button is not disabled");
});

test("a label is drawn as text and not as markup", async () => {
  const module = await load("draw-text");
  const body = document.createElement("div");
  module.drawValue(body, list([item("a", { label: "<b>x</b>" })]).elements, { owner: "demo", bind: () => {} });
  assert.equal(body.querySelector("b"), null, "the label was drawn as markup");
  assert.ok(body.textContent.includes("<b>x</b>"), "the label text was not drawn");
});

test("a rejected value shows its text in the section and writes the log line once", async () => {
  const module = await load("display-reject");
  reports.length = 0;
  {
    const body = document.createElement("div");
    body.appendChild(document.createElement("p"));
    module.receive(body, { elements: [{ kind: "chart", key: "x" }] }, { ...OPTIONS, status: "reject", bind: () => {} });
    assert.equal(body.querySelectorAll("p").length, 0, "the previous tree was not removed");
    assert.equal(body.dataset.error, "declared UI demo.reject");
    assert.equal(body.textContent, '/elements/0/kind: unknown kind "chart"');
    assert.deepEqual(reports, ['declared UI demo.reject: /elements/0/kind: unknown kind "chart"']);
  }
});

test("an accepted value after a rejection withdraws the error and draws the list", async () => {
  const module = await load("display-accept");
  const body = document.createElement("div");
  module.receive(body, { elements: [{ kind: "chart", key: "x" }] }, { ...OPTIONS, status: "accept", bind: () => {} });
  module.receive(body, list([item("a")]), { ...OPTIONS, status: "accept", bind: () => {} });
  assert.equal(body.dataset.error, undefined, "the error display was not withdrawn");
  assert.ok(body.textContent.includes("a"), "the accepted list was not drawn");
});
