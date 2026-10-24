// Validation, drawing, and the display path of a declared UI value of a list (docs/spec/declared-ui.md).
// The rules are the ones of the rejection table, the list element, the dom names, and the binding.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { resolveSectionControl } from "../section-address.js";

const dom = new JSDOM("<body><div id=body></div></body>");
globalThis.document = dom.window.document;

// The log lines of the display path are collected through the host report function (shown-errors.js).
const reports = [];
mock.module("../host.js", { namedExports: { report: (line) => { reports.push(line); } } });

const OPTIONS = {
  owner: "demo",
  declared: (name) => name === "demo.open" || name === "demo.select",
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
  const bind = (el, name, params, options) => { calls.push({ el, name, params: () => (typeof params === "function" ? params() : params), options }); return el; };
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
  assert.deepEqual(calls[0].params(), { id: 1 });
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

// Tree elements (docs/spec/declared-ui.md): node drawing, expand requests, plugin-authoritative expanded values, and tree rules.
const EXPAND = "core.declared-ui.tree.expand";
const MOVE = "core.declared-ui.tree.move";
const branch =(key, children, extra = {}) => ({ key, label: key, children, ...extra });
const leaf = (key, extra = {}) => ({ key, label: key, ...extra });
const tree = (nodes, extra = {}) => ({ elements: [{ kind: "tree", key: "t1", empty: "none", nodes, ...extra }] });

/** A section of the status demo.s whose binds are recorded. show receives a value, expand runs the expand command. */
function section(module, orientation = "vertical") {
  const body = document.createElement("div");
  const calls = [];
  const runs = [];
  const expansionRequests = [];
  const bind = (el, name, params, options) => {
    const entry = { el, name, params: () => (typeof params === "function" ? params() : params), options };
    el.dataset.command = name;
    if (typeof params !== "function" && params && Object.keys(params).length) el.dataset.params = JSON.stringify(params);
    else delete el.dataset.params;
    calls.push(entry);
    el.addEventListener(options.event ?? "click", (event) => {
      if (options.when && !options.when(event)) return;
      if (options.stop) event.stopPropagation();
      const args = typeof params === "function" ? params(event) : params;
      runs.push({ name, params: args, type: event.type, detail: event.detail ?? 0 });
      // The registry runs the handlers of the core commands; the harness calls the same handlers.
      if (name === MOVE) module.moveTreeFocus(args);
      if (name === EXPAND) module.setTreeExpanded(args);
    });
    return el;
  };
  const options = { ...OPTIONS, status: "s", orientation, bind, expanded: (request) => expansionRequests.push(request) };
  return {
    body,
    calls,
    runs,
    expansionRequests,
    show(value) { assert.doesNotThrow(() => module.receive(body, value, options), "the tree value was not drawn"); },
    expand(path, expanded) { module.setTreeExpanded({ status: "demo.s", tree: "t1", path, expanded }); },
    labels() { return [...body.querySelectorAll(".declared-label")].map((label) => label.textContent); },
    requested(path) {
      const control = body.querySelector(`[data-role="expand"][data-path='${JSON.stringify(path)}']`);
      assert.ok(control, `no expand control for ${JSON.stringify(path)}`);
      return calls.filter((call) => call.el === control).at(-1);
    },
  };
}

test("a tree draws its branches and leaves, and the children of an expanded branch", async () => {
  const module = await load("tree-draw");
  const s = section(module);
  s.show(tree([branch("b", [leaf("c")], { expanded: true }), leaf("l")]));
  assert.deepEqual(s.labels(), ["b", "c", "l"]);
});

test("a tree root address resolves the actual rendered root across redraws and multiple trees", async () => {
  const module = await load("tree-root-address");
  const body = document.createElement("section");
  body.className = "set__section";
  body.dataset.sidebar = "left";
  body.dataset.section = "files.tree";
  const value = (rootLabel, bookmarkLabel) => ({ elements: [
    { kind: "tree", key: "files", empty: "none", nodes: [leaf("root", { label: rootLabel, command: "demo.select" })] },
    { kind: "tree", key: "bookmarks", empty: "none", nodes: [leaf("saved", { label: bookmarkLabel, command: "demo.select" })] },
  ] });
  const controls = () => [...body.querySelectorAll('[data-expose="core.sidebar.section.control"]')];
  const address = (key, extra = {}) => ({ sidebar: "left", section: "files.tree", key, ...extra });
  const bind = (element) => { element.dataset.expose = "core.sidebar.section.control"; };
  const draw = (elements) => module.drawValue(body, elements, {
    statusId: "demo.s", bind,
    expandedByTree: new Map([["files", new Map()], ["bookmarks", new Map()]]),
  });
  draw(value("Root", "Saved").elements);
  const roots = () => [...body.querySelectorAll(".declared-tree")];
  const [filesRoot, bookmarksRoot] = roots();
  assert.equal(resolveSectionControl(address("files"), controls()), filesRoot);
  assert.equal(resolveSectionControl(address("bookmarks"), controls()), bookmarksRoot);
  assert.equal(filesRoot.dataset.key, "files", "the files tree root does not carry its declared key");
  assert.equal(bookmarksRoot.dataset.key, "bookmarks", "the bookmark tree root does not carry its declared key");
  const child = resolveSectionControl(address("files", { path: ["root"], role: "label" }), controls());

  draw(value("Renamed root", "Renamed saved").elements);
  assert.equal(roots()[0], filesRoot, "redraw replaced the tree root box");
  assert.equal(roots()[1], bookmarksRoot, "redraw replaced the second tree root box");
  assert.equal(resolveSectionControl(address("files"), controls()), filesRoot, "redraw lost the root address");
  assert.equal(resolveSectionControl(address("bookmarks"), controls()), bookmarksRoot, "redraw changed the second root address");
  assert.equal(resolveSectionControl(address("files", { path: ["root"], role: "label" }), controls()), child,
    "redraw replaced the addressed child control");
  assert.equal(child.textContent, "Renamed root", "redraw did not update the retained child control");
});

test("a collapsed branch hides its children, and its expand control requests the opposite state", async () => {
  const module = await load("tree-collapsed");
  const s = section(module);
  s.show(tree([branch("b", [leaf("c")])]));
  assert.deepEqual(s.labels(), ["b"]);
  const control = s.body.querySelector('[data-role="expand"]');
  assert.equal(control.tagName, "BUTTON", "the expand control is not a button");
  assert.equal(control.dataset.key, "t1");
  assert.equal(control.dataset.path, '["b"]');
  assert.equal(control.dataset.expose, "core.sidebar.section.control");
  const call = s.requested(["b"]);
  assert.equal(call.name, EXPAND);
  assert.deepEqual(call.params(), { status: "demo.s", tree: "t1", path: ["b"], expanded: true });
  assert.deepEqual(call.options, { event: "click" });
  assert.equal(s.body.querySelector(".declared-label").hasAttribute("data-role"), false, "a static branch label carries a role");
});

test("a node with command draws a bound label, and a static leaf carries no control attributes", async () => {
  const module = await load("tree-label");
  const s = section(module);
  s.show(tree([branch("b", [leaf("c")], { command: "demo.open", params: { id: 1 }, expanded: true }), leaf("x")]));
  const [b, c, x] = s.body.querySelectorAll(".declared-label");
  assert.equal(b.tagName, "BUTTON", "the node with command is not a button");
  assert.equal(b.dataset.key, "t1");
  assert.equal(b.dataset.path, '["b"]');
  assert.equal(b.dataset.role, "label");
  assert.equal(b.dataset.expose, "core.sidebar.section.control");
  const bound = s.calls.find((call) => call.el === b);
  assert.equal(bound.name, "demo.open");
  assert.deepEqual(bound.params(), { id: 1 });
  assert.deepEqual(bound.options, { event: "click" });
  for (const label of [c, x]) {
    assert.equal(label.tagName, "SPAN", "a static label is not a span");
    assert.equal(label.hasAttribute("data-expose"), false, "a static label carries a dom name");
    assert.equal(label.hasAttribute("data-key"), false, "a static label carries data-key");
  }
  assert.equal(s.requested(["b"]).params().expanded, false, "an expanded branch does not request collapse");
});

test("a node with enabled false draws its button disabled", async () => {
  const module = await load("tree-disabled");
  const s = section(module);
  s.show(tree([leaf("d", { command: "demo.open", enabled: false })]));
  assert.equal(s.body.querySelector("button").disabled, true, "the button is not disabled");
});

test("a selected node is marked on its row, and an unselected node is not", async () => {
  const module = await load("tree-selected");
  const s = section(module);
  s.show(tree([leaf("l", { selected: true }), leaf("m")]));
  const rows = [...s.body.querySelectorAll(".declared-row")];
  assert.deepEqual(rows.map((row) => row.dataset.selected), ["true", undefined]);
});

test("an empty tree draws its empty text and no node", async () => {
  const module = await load("tree-empty");
  const s = section(module);
  s.show(tree([]));
  assert.equal(s.body.textContent, "none", "the empty text was not drawn");
  assert.equal(s.body.querySelector(".declared-label"), null, "a node was drawn");
});

test("a tree expansion waits for the authoritative plugin value", async () => {
  const module = await load("tree-expanded-authoritative");
  const s = section(module);
  const collapsed = tree([branch("b", [leaf("c")])]);
  s.show(collapsed);
  s.expand(["b"], true);
  assert.deepEqual(s.expansionRequests, [{ status: "demo.s", tree: "t1", path: ["b"], expanded: true }]);
  assert.deepEqual(s.labels(), ["b"], "the tree changed before the plugin round trip");
  s.show(tree([branch("b", [leaf("c")], { expanded: true })]));
  assert.deepEqual(s.labels(), ["b", "c"], "the tree did not adopt the plugin's returned expanded value");
});

test("the accepted plugin expanded value remains authoritative until its next snapshot", async () => {
  const module = await load("tree-kept");
  const s = section(module);
  const collapsed = tree([branch("b", [leaf("c")])]);
  s.show(collapsed);
  assert.deepEqual(s.labels(), ["b"]);
  s.expand(["b"], true);
  assert.deepEqual(s.expansionRequests[0], { status: "demo.s", tree: "t1", path: ["b"], expanded: true });
  assert.deepEqual(s.labels(), ["b"], "the workbench optimistically expanded before the plugin snapshot");
  s.show(collapsed);
  assert.deepEqual(s.labels(), ["b"], "an unchanged plugin value did not remain authoritative");
  s.show(tree([branch("b", [leaf("c")], { expanded: true })]));
  assert.deepEqual(s.labels(), ["b", "c"], "the accepted plugin value did not expand the branch");
  assert.equal(s.requested(["b"]).params().expanded, false, "the expanded branch does not request collapse");
  s.expand(["b"], false);
  assert.deepEqual(s.labels(), ["b", "c"], "the workbench optimistically collapsed before the plugin snapshot");
  s.show(collapsed);
  assert.deepEqual(s.labels(), ["b"], "the accepted collapsed plugin value was ignored");
});

test("an expansion request names the full path and waits for the plugin value", async () => {
  const module = await load("tree-path");
  const s = section(module);
  s.show(tree([branch("b", [branch("c", [leaf("d")])], { expanded: true })]));
  assert.deepEqual(s.labels(), ["b", "c"]);
  s.expand(["b", "c"], true);
  assert.deepEqual(s.expansionRequests[0], { status: "demo.s", tree: "t1", path: ["b", "c"], expanded: true });
  assert.deepEqual(s.labels(), ["b", "c"], "the expansion request changed the drawing before the source answered");
  s.show(tree([branch("b", [branch("c", [leaf("d")], { expanded: true })], { expanded: true })]));
  assert.deepEqual(s.labels(), ["b", "c", "d"], "the plugin's expanded path was not drawn");
});

test("the plugin value determines branch and leaf state across accepted values", async () => {
  const module = await load("tree-new-leaf");
  const s = section(module);
  s.show(tree([branch("b", [leaf("c")])]));
  s.expand(["b"], true);
  assert.deepEqual(s.labels(), ["b"], "the request changed the drawing before the plugin reply");
  s.show(tree([leaf("b")]));
  assert.deepEqual(s.labels(), ["b"], "a leaf drew children");
  s.show(tree([branch("b", [leaf("c")])]));
  assert.deepEqual(s.labels(), ["b"], "a branch that came back was not collapsed by its plugin value");
  s.show(tree([leaf("x"), branch("d", [leaf("e")], { expanded: true })]));
  assert.deepEqual(s.labels(), ["x", "d", "e"], "a new expanded branch did not follow its plugin value");
});

test("the plugin value remains authoritative after a rejected snapshot", async () => {
  const module = await load("tree-no-baseline");
  const s = section(module);
  s.show(tree([branch("b", [leaf("c")], { expanded: true })]));
  s.expand(["b"], false);
  s.expand(["b"], true);
  assert.deepEqual(s.labels(), ["b", "c"], "an expansion request changed the drawn value");
  assert.deepEqual(s.expansionRequests.map(({ expanded }) => expanded), [false, true]);
  s.show({ elements: [{ kind: "chart", key: "x" }] });
  assert.deepEqual(s.labels(), [], "the rejected value kept the tree");
  assert.throws(() => s.expand(["b"], false), { message: 'tree t1 path ["b"] is not drawn' });
  s.show(tree([branch("b", [leaf("c")])]));
  assert.deepEqual(s.labels(), ["b"], "the plugin's collapsed value was overridden by a stale workbench state");
});

test("a source change clears expansion authority and uses the next plugin value", async () => {
  const module = await load("tree-source");
  const s = section(module);
  s.show(tree([branch("b", [leaf("c")])]));
  s.expand(["b"], true);
  assert.deepEqual(s.labels(), ["b"], "the source request expanded optimistically");
  module.changeSource("demo.s");
  assert.throws(() => s.expand(["b"], false), { message: 'tree t1 path ["b"] is not drawn' });
  s.show(tree([branch("b", [leaf("c")])]));
  assert.deepEqual(s.labels(), ["b"], "the new plugin source did not supply its collapsed value");
});

test("a path that is not a drawn branch, a tree that is not drawn, and a status that is not drawn fail the command", async () => {
  const module = await load("tree-not-drawn");
  const s = section(module);
  assert.throws(() => s.expand(["b"], true), { message: 'tree t1 path ["b"] is not drawn' }, "a status with no value");
  s.show(tree([leaf("l"), branch("b", [leaf("c")])]));
  assert.throws(() => s.expand(["l"], true), { message: 'tree t1 path ["l"] is not drawn' }, "a leaf");
  assert.throws(() => s.expand(["zz"], true), { message: 'tree t1 path ["zz"] is not drawn' }, "a missing path");
  assert.throws(
    () => module.setTreeExpanded({ status: "demo.s", tree: "t2", path: ["b"], expanded: true }),
    { message: 'tree t2 path ["b"] is not drawn' },
    "a tree that is not drawn",
  );
  assert.throws(
    () => module.setTreeExpanded({ status: "demo.other", tree: "t1", path: ["b"], expanded: true }),
    { message: 'tree t1 path ["b"] is not drawn' },
    "a status that is not drawn",
  );
});

test("the expand command forwards every request to the authoritative source", async () => {
  const module = await load("tree-repeat");
  const s = section(module);
  s.show(tree([branch("b", [leaf("c")])]));
  s.expand(["b"], true);
  s.expand(["b"], true);
  assert.deepEqual(s.expansionRequests, [
    { status: "demo.s", tree: "t1", path: ["b"], expanded: true },
    { status: "demo.s", tree: "t1", path: ["b"], expanded: true },
  ]);
  assert.deepEqual(s.labels(), ["b"], "the expansion command changed local drawing state");
});

test("a tree in a horizontal section is drawn with its outline, as in a vertical section", async () => {
  const module = await load("tree-horizontal");
  const s = section(module, "horizontal");
  s.show(tree([branch("b", [leaf("c")], { expanded: true }), leaf("l")]));
  assert.deepEqual(s.labels(), ["b", "c", "l"], "the tree was not drawn in a horizontal section");
  assert.equal(s.body.dataset.error, undefined, "the tree in a horizontal section shows an error");
  assert.equal(s.body.querySelector(".declared-tree").children.length, 2, "the root nodes are not drawn in order");
});

test("expanded on a leaf is rejected at the expanded field, also for a branch with no children", async () => {
  const module = await load("tree-expanded-leaf");
  const error = rejectionOf(tree([leaf("l", { expanded: false })]), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/nodes/0/expanded");
  assert.equal(error.reason, "expanded is allowed only on a branch");
  const empty = rejectionOf(tree([{ key: "e", label: "e", children: [], expanded: true }]), OPTIONS, module);
  assert.equal(empty?.pointer, "/elements/0/nodes/0/expanded");
  assert.equal(empty?.reason, "expanded is allowed only on a branch");
});

test("a tree of 16 levels is accepted, and a node at level 17 is rejected at the node", async () => {
  const module = await load("tree-levels");
  const nest = (level, depth) => (level === depth ? leaf(`n${level}`) : branch(`n${level}`, [nest(level + 1, depth)]));
  assert.equal(rejectionOf(tree([nest(1, 16)]), OPTIONS, module), null, "16 levels were rejected");
  const error = rejectionOf(tree([nest(1, 17)]), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, `/elements/0/nodes/0${"/children/0".repeat(16)}`);
  assert.equal(error.reason, "exceeds 16 levels");
});

test("more than 5000 tree nodes are rejected at the nodes array, and 5000 are accepted", async () => {
  const module = await load("tree-nodes");
  const nodes = (count) => Array.from({ length: count }, (_, i) => leaf(`k${i}`));
  assert.equal(rejectionOf(tree(nodes(5000)), OPTIONS, module), null, "5000 nodes were rejected");
  const error = rejectionOf(tree(nodes(5001)), OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0/nodes");
  assert.equal(error.reason, "exceeds 5000 nodes");
});

test("a tree is accepted with the same value in a horizontal and in a vertical section", async () => {
  const module = await load("tree-orientation");
  const value = tree([leaf("l")]);
  assert.equal(rejectionOf(value, { ...OPTIONS, orientation: "vertical" }, module), null, "a vertical tree was rejected");
  assert.equal(rejectionOf(value, { ...OPTIONS, orientation: "horizontal" }, module), null, "a horizontal tree was rejected");
});

// Tree node detail (docs/spec/declared-ui.md, element table): plain text drawn after the label, as the detail of a list item.
test("a tree node draws its detail after its label, and a branch draws its detail too", async () => {
  const module = await load("tree-detail");
  const s = section(module);
  s.show(tree([branch("b", [leaf("c", { detail: "A" })], { expanded: true, detail: "2 changed" }), leaf("l", { detail: "M" })]));
  assert.equal(s.body.querySelectorAll(".declared-detail").length, 3, "a detail is missing");
  const leafRow = [...s.body.querySelectorAll(".declared-row")].find((r) => r.textContent.startsWith("l"));
  assert.equal(leafRow.querySelector(".declared-detail").textContent, "M", "the leaf detail is not drawn");
  assert.equal(leafRow.lastElementChild.className, "declared-detail", "the detail is not drawn after the label");
  const branchRow = [...s.body.querySelectorAll(".declared-row")].find((r) => r.textContent.startsWith("b"));
  assert.equal(branchRow.querySelector(".declared-detail").textContent, "2 changed", "the branch detail is not drawn");
  s.show(tree([leaf("l", { detail: "A" })]));
  assert.equal(s.body.querySelector(".declared-detail").textContent, "A", "a redraw did not update the detail");
  s.show(tree([leaf("l")]));
  assert.equal(s.body.querySelector(".declared-detail"), null, "a detail that the value no longer carries is still drawn");
});

test("a tree node detail is plain text of at most 500 code points, and is rejected at the field", async () => {
  const module = await load("tree-detail-rules");
  assert.equal(rejectionOf(tree([leaf("l", { detail: "x".repeat(500) })]), OPTIONS, module), null, "a detail of 500 code points was rejected");
  const long = rejectionOf(tree([leaf("l", { detail: "x".repeat(501) })]), OPTIONS, module);
  assert.ok(long, "no rejection for a long detail");
  assert.equal(long.pointer, "/elements/0/nodes/0/detail");
  assert.equal(long.reason, "exceeds 500 code points");
  const control = rejectionOf(tree([leaf("l", { detail: "a\u0007b" })]), OPTIONS, module);
  assert.equal(control.pointer, "/elements/0/nodes/0/detail");
  assert.equal(control.reason, '"detail" contains a control character');
  const type = rejectionOf(tree([leaf("l", { detail: 1 })]), OPTIONS, module);
  assert.equal(type.pointer, "/elements/0/nodes/0/detail");
  assert.equal(type.reason, '"detail" must be string');
});

// Keyed redraw (docs/spec/exposure.md, redraw rule): a control whose address stays keeps its element, and its command is bound once.
test("a redraw keeps the element of each list row whose key stays", async () => {
  const module = await load("keep-row");
  const s = section(module);
  s.show(list([item("a", { command: "demo.open" }), item("b")]));
  const rows = [...s.body.querySelectorAll(".declared-row")];
  s.show(list([item("a", { command: "demo.open" }), item("b", { detail: "two" })]));
  const kept = [...s.body.querySelectorAll(".declared-row")];
  assert.equal(kept.length, 2, "the rows were not drawn");
  assert.equal(kept[0], rows[0], "the row of an unchanged key was replaced");
  assert.equal(kept[1], rows[1], "the row of an unchanged key was replaced");
});

test("a redraw keeps the expand control of a branch and binds it once", async () => {
  const module = await load("keep-expand");
  const s = section(module);
  s.show(tree([branch("b", [leaf("c")])]));
  const control = s.body.querySelector('[data-role="expand"]');
  const bound = s.calls.length;
  s.show(tree([branch("b", [leaf("c")])]));
  assert.equal(s.body.querySelector('[data-role="expand"]'), control, "the expand control was replaced");
  assert.equal(s.calls.length, bound, "the control or the tree was bound again by the redraw");
});

test("the expand control keeps keyboard focus after its command draws the tree again", async () => {
  const module = await load("keep-focus");
  const s = section(module);
  document.body.append(s.body);
  try {
    s.show(tree([branch("b", [leaf("c")])]));
    const control = s.body.querySelector('[data-role="expand"]');
    control.focus();
    assert.equal(document.activeElement, control, "the control did not take focus");
    s.expand(["b"], true);
    assert.equal(document.activeElement, control, "focus left the expand control after the command");
    assert.equal(control.isConnected, true, "the expand control left the document");
  } finally {
    s.body.remove();
  }
});

test("a changed parameter updates the kept button without binding it again", async () => {
  const module = await load("keep-params");
  const s = section(module);
  s.show(list([item("a", { command: "demo.open", params: { id: 1 } })]));
  const button = s.body.querySelector("button");
  s.show(list([item("a", { command: "demo.open", params: { id: 2 } })]));
  assert.equal(s.body.querySelector("button"), button, "the button was replaced");
  assert.equal(s.calls.length, 1, "the button was bound again");
  assert.deepEqual(s.calls[0].params(), { id: 2 }, "the bound parameters were not updated");
});

// The button element (docs/spec/declared-ui.md): one button bound to its command, with its icon, its enabled state, and the control attributes.
const button = (key, extra = {}) => ({ kind: "button", key, label: key, command: "demo.open", ...extra });

test("a button draws its label and icon, bound to its command with the control attributes", async () => {
  const module = await load("button-draw");
  const s = section(module);
  s.show({ elements: [button("go", { params: { id: 1 }, icon: "star" })] });
  const control = s.body.querySelector("button");
  assert.ok(control, "no button was drawn");
  assert.equal(control.textContent, "go");
  assert.ok(control.querySelector(".declared-icon svg"), "the icon was not drawn");
  assert.equal(control.dataset.key, "go");
  assert.equal(control.dataset.expose, "core.sidebar.section.control");
  assert.equal(control.hasAttribute("data-path"), false, "a button carries data-path");
  assert.equal(control.hasAttribute("data-role"), false, "a button carries data-role");
  const call = s.calls.find((entry) => entry.el === control);
  assert.equal(call.name, "demo.open");
  assert.deepEqual(call.params(), { id: 1 });
  assert.deepEqual(call.options, { event: "click" });
});

test("a button with enabled false is disabled, and a button without enabled is not", async () => {
  const module = await load("button-enabled");
  const s = section(module);
  s.show({ elements: [button("off", { enabled: false })] });
  assert.equal(s.body.querySelector("button").disabled, true, "the button is not disabled");
  s.show({ elements: [button("on")] });
  assert.equal(s.body.querySelector("button").disabled, false, "the button without enabled is disabled");
});

test("a redraw keeps the element of a button and connects it once", async () => {
  const module = await load("button-keep");
  const s = section(module);
  s.show({ elements: [button("go", { params: { id: 1 } })] });
  const control = s.body.querySelector("button");
  s.show({ elements: [button("go", { params: { id: 2 } })] });
  assert.equal(s.body.querySelector("button"), control, "the button was replaced");
  assert.equal(s.calls.length, 1, "the button was bound again");
  assert.deepEqual(s.calls[0].params(), { id: 2 }, "the bound parameters were not updated");
});

test("a button without command is rejected at the button", async () => {
  const module = await load("button-command");
  const error = rejectionOf({ elements: [{ kind: "button", key: "go", label: "go" }] }, OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0");
  assert.equal(error.reason, 'missing "command"');
});

// The status-line element (docs/spec/declared-ui.md): one line of plain text, with no command and no control attributes.
test("a status line draws its text as one line with no control attributes", async () => {
  const module = await load("status-line-draw");
  const s = section(module);
  s.show({ elements: [{ kind: "status-line", key: "st", text: "Ready" }] });
  assert.equal(s.body.textContent, "Ready", "the text was not drawn");
  assert.equal(s.body.querySelector("button"), null, "the status line draws a button");
  assert.equal(s.body.querySelector("[data-expose]"), null, "the status line carries a dom name");
  assert.equal(s.body.querySelector("[data-key]"), null, "the status line carries data-key");
  assert.equal(s.calls.length, 0, "the status line is bound to a command");
});

test("a status line draws its text as text and not as markup", async () => {
  const module = await load("status-line-text");
  const s = section(module);
  s.show({ elements: [{ kind: "status-line", key: "st", text: "<b>x</b>" }] });
  assert.equal(s.body.querySelector("b"), null, "the text was drawn as markup");
  assert.equal(s.body.textContent, "<b>x</b>", "the text was not drawn");
});

test("a redraw keeps the element of a status line", async () => {
  const module = await load("status-line-keep");
  const s = section(module);
  s.show({ elements: [{ kind: "status-line", key: "st", text: "Ready" }] });
  const line = s.body.firstElementChild;
  s.show({ elements: [{ kind: "status-line", key: "st", text: "Done" }] });
  assert.equal(s.body.firstElementChild, line, "the status line was replaced");
  assert.equal(line.textContent, "Done", "the text was not updated");
});

test("a branch flag declares an unloaded branch without children", async () => {
  const module = await load("unloaded-branch");
  const value = tree([leaf("folder", { branch: true })]);
  const error = rejectionOf(value, OPTIONS, module);
  assert.equal(error, null, error?.reason ?? "an unloaded branch was rejected");
  const s = section(module);
  s.show(value);
  assert.ok(s.body.querySelector('[data-role="expand"]'), "an unloaded branch has no expand control");
});

test("an expanded unloaded branch keeps its state until children arrive", async () => {
  const module = await load("unloaded-branch-children");
  const s = section(module);
  s.show(tree([leaf("folder", { branch: true })]));
  assert.ok(s.body.querySelector('[data-role="expand"]'), "the unloaded branch has no expand control");
  s.expand(["folder"], true);
  s.show(tree([branch("folder", [leaf("child")], { branch: true, expanded: true })]));
  assert.deepEqual(s.labels(), ["folder", "child"], "children did not draw after they arrived for an expanded branch");
});

test("the node limit counts unloaded branches", async () => {
  const module = await load("unloaded-branch-limit");
  const nodes = (count) => Array.from({ length: count }, (_, index) => leaf("f" + index, { branch: true }));
  assert.equal(rejectionOf(tree(nodes(5000)), OPTIONS, module), null, "5000 unloaded branches were rejected");
  const error = rejectionOf(tree(nodes(5001)), OPTIONS, module);
  assert.ok(error, "5001 unloaded branches were accepted");
  assert.equal(error.pointer, "/elements/0/nodes");
  assert.equal(error.reason, "exceeds 5000 nodes");
});

test("the branch flag must be boolean", async () => {
  const module = await load("branch-type");
  const error = rejectionOf(tree([leaf("folder", { branch: "yes" })]), OPTIONS, module);
  assert.ok(error, "a non-boolean branch flag was accepted");
  assert.equal(error.pointer, "/elements/0/nodes/0/branch");
  assert.equal(error.reason, '"branch" must be boolean');
});

test("root header buttons stay before a tree and run their declared command", async () => {
  const module = await load("tree-header-button");
  const s = section(module);
  s.show({ elements: [
    { kind: "button", key: "add", label: "Add", command: "demo.open" },
    ...tree([leaf("file")]).elements,
  ] });
  assert.deepEqual([...s.body.children].map(({ className }) => className), ["declared-button", "declared-tree"]);
  s.body.firstElementChild.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
  assert.deepEqual(s.runs.map(({ name }) => name), ["demo.open"]);
});

test("tree node actions are bounded and have unique keys", async () => {
  const module = await load("tree-action-validation");
  const action = (key) => ({ key, label: key, command: "demo.open" });
  const tooMany = rejectionOf(tree([leaf("n", { actions: [action("a"), action("b"), action("c")] })]), OPTIONS, module);
  assert.ok(tooMany, "three node actions were accepted");
  assert.equal(tooMany.pointer, "/elements/0/nodes/0/actions");
  assert.equal(tooMany.reason, "exceeds 2 actions");
  const duplicate = rejectionOf(tree([leaf("n", { actions: [action("a"), action("a")] })]), OPTIONS, module);
  assert.ok(duplicate, "duplicate action keys were accepted");
  assert.equal(duplicate.pointer, "/elements/0/nodes/0/actions/1/key");
  assert.equal(duplicate.reason, 'duplicate key "a"');
});

test("tree node actions draw after detail and expose their action address", async () => {
  const module = await load("tree-actions");
  const s = section(module);
  const actions = [
    { key: "rename", label: "Rename", command: "demo.open", params: { id: "n" } },
    { key: "copy", label: "Copy", command: "demo.select" },
  ];
  s.show(tree([leaf("n", { command: "demo.select", detail: "File", actions })]));
  const row = s.body.querySelector(".declared-row");
  assert.ok(row.querySelector(".declared-actions"), "tree actions were not drawn");
  assert.deepEqual([...row.children].map((child) => child.className), ["declared-label", "declared-detail", "declared-actions"]);
  const rename = row.querySelector('[data-role="action"][data-action="rename"]');
  assert.ok(rename, "the rename action is missing");
  assert.equal(rename.tagName, "BUTTON");
  assert.equal(rename.dataset.key, "t1");
  assert.equal(rename.dataset.path, '["n"]');
  assert.equal(rename.dataset.expose, "core.sidebar.section.control");
  assert.equal(rename.dataset.command, "demo.open");
  rename.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
  assert.deepEqual(s.runs.map(({ name, params }) => [name, params]), [["demo.open", { id: "n" }]]);
});

test("a tree node with open handles Enter and double press separately from command", async () => {
  const module = await load("tree-open-actions");
  const s = section(module);
  s.show(tree([leaf("n", { command: "demo.select", open: "demo.open" })]));
  const label = s.body.querySelector(".declared-label");
  assert.ok(label, "the tree node with open was not drawn");
  const enter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  label.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true, "Enter did not prevent the native click");
  assert.deepEqual(s.runs.map(({ name }) => name), ["demo.open"], "Enter did not run open exactly once");
  s.runs.length = 0;
  label.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
  label.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 2 }));
  assert.deepEqual(s.runs.map(({ name }) => name), ["demo.select", "demo.open"], "a double press did not run command then open");
});

test("a tree node with only open is focusable and opens on Enter and double press", async () => {
  const module = await load("tree-open-only");
  const s = section(module);
  s.show(tree([leaf("n", { open: "demo.open" })]));
  const label = s.body.querySelector(".declared-label");
  assert.equal(label.tagName, "BUTTON");
  label.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
  assert.deepEqual(s.runs, [], "a single click ran open without a command");
  const enter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  label.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(s.runs.map(({ name }) => name), ["demo.open"]);
  s.runs.length = 0;
  label.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
  label.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 2 }));
  assert.deepEqual(s.runs.map(({ name }) => name), ["demo.open"]);
});

test("Enter on a tree node without open has no declared key handler", async () => {
  const module = await load("tree-no-open-key");
  const s = section(module);
  s.show(tree([leaf("n", { command: "demo.select" })]));
  const label = s.body.querySelector(".declared-label");
  const enter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  label.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false);
  assert.deepEqual(s.runs, []);
});

test("a status line with a command is rejected at the unknown field", async () => {
  const module = await load("status-line-command");
  const error = rejectionOf({ elements: [{ kind: "status-line", key: "st", text: "Ready", command: "demo.open" }] }, OPTIONS, module);
  assert.ok(error, "no rejection");
  assert.equal(error.pointer, "/elements/0");
  assert.equal(error.reason, 'unknown field "command"');
});

// Tree keys (docs/spec/declared-ui.md, Tree keys): the arrow keys, Home and End move focus between the focus targets of the visible
// nodes, and the expansion rows run core.declared-ui.tree.expand. The harness runs the handlers of the core commands, as the registry does.
const keyNodes = () => [
  leaf("a", { command: "demo.open" }),
  branch("b", [leaf("b1", { command: "demo.open" }), leaf("b2")], { command: "demo.open", expanded: true }),
  branch("c", [leaf("c1", { command: "demo.open" })]),
  leaf("d"),
  leaf("e", { command: "demo.open", enabled: false }),
];

/** A section of the status demo.s drawn in the document, so that focus can move between its controls. */
async function keyboardSection(name, value) {
  const module = await load(name);
  const s = section(module);
  document.body.append(s.body);
  s.show(value);
  return s;
}

/** The focused control as `<role> <path>`, or `body` when no control has focus. */
const focusName = () => {
  const el = document.activeElement;
  return el?.dataset.role ? `${el.dataset.role} ${el.dataset.path}` : "body";
};

/** Sends a keydown to the focused control and returns the event. */
function press(name, init = {}) {
  const event = new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  document.activeElement.dispatchEvent(event);
  return event;
}

/** Focuses the control of the node at path with the role label or expand. */
function focusOn(s, path, role) {
  const el = s.body.querySelector(`[data-role="${role}"][data-path='${JSON.stringify(path)}']`);
  assert.ok(el, `no ${role} control for ${JSON.stringify(path)}`);
  el.focus();
  assert.equal(focusName(), `${role} ${JSON.stringify(path)}`, "the control did not take focus");
}

test("ArrowDown and ArrowUp move focus between focus targets, and skip a node that has none", async () => {
  const s = await keyboardSection("keys-down-up", tree(keyNodes()));
  try {
    focusOn(s, ["a"], "label");
    press("ArrowDown");
    assert.equal(focusName(), 'label ["b"]', "ArrowDown did not move to the next node");
    press("ArrowDown");
    assert.equal(focusName(), 'label ["b","b1"]', "ArrowDown did not move to the first child");
    press("ArrowDown");
    assert.equal(focusName(), 'expand ["c"]', "ArrowDown did not skip b2, which has no focus target");
    press("ArrowDown");
    assert.equal(focusName(), 'expand ["c"]', "ArrowDown at the last node moved focus");
    press("ArrowUp");
    assert.equal(focusName(), 'label ["b","b1"]', "ArrowUp did not move to the previous node with a focus target");
    press("ArrowUp");
    assert.equal(focusName(), 'label ["b"]', "ArrowUp did not move to the parent's previous node");
  } finally {
    s.body.remove();
  }
});

test("Home and End move focus to the first and the last node with a focus target, and the ends keep focus", async () => {
  const s = await keyboardSection("keys-home-end", tree(keyNodes()));
  try {
    focusOn(s, ["b", "b1"], "label");
    const home = press("Home");
    assert.equal(home.defaultPrevented, true, "Home was not handled");
    assert.equal(focusName(), 'label ["a"]', "Home did not move to the first node");
    const up = press("ArrowUp");
    assert.equal(up.defaultPrevented, true, "ArrowUp at the first node was not handled");
    assert.equal(focusName(), 'label ["a"]', "ArrowUp at the first node moved focus");
    press("End");
    assert.equal(focusName(), 'expand ["c"]', "End did not move to the last node with a focus target");
    press("ArrowDown");
    assert.equal(focusName(), 'expand ["c"]', "ArrowDown at the last node moved focus");
  } finally {
    s.body.remove();
  }
});

test("ArrowRight on a collapsed branch requests its expansion, and ArrowLeft on a root branch keeps focus", async () => {
  const s = await keyboardSection("keys-collapsed", tree(keyNodes()));
  try {
    focusOn(s, ["c"], "expand");
    const right = press("ArrowRight");
    assert.equal(right.defaultPrevented, true, "ArrowRight on a collapsed branch was not handled");
    assert.deepEqual(s.expansionRequests, [{ status: "demo.s", tree: "t1", path: ["c"], expanded: true }]);
    assert.equal(focusName(), 'expand ["c"]', "ArrowRight moved focus");
    const left = press("ArrowLeft");
    assert.equal(left.defaultPrevented, true, "ArrowLeft on a root node was not handled");
    assert.equal(focusName(), 'expand ["c"]', "ArrowLeft on a root node moved focus");
    assert.equal(s.expansionRequests.length, 1, "ArrowLeft on a collapsed branch requested a collapse");
  } finally {
    s.body.remove();
  }
});

test("ArrowRight on an expanded branch moves focus to its first child with a focus target, and ArrowLeft requests its collapse", async () => {
  const s = await keyboardSection("keys-expanded", tree(keyNodes()));
  try {
    focusOn(s, ["b"], "label");
    press("ArrowRight");
    assert.equal(focusName(), 'label ["b","b1"]', "ArrowRight did not move to the first child with a focus target");
    press("ArrowLeft");
    assert.equal(focusName(), 'label ["b"]', "ArrowLeft on a leaf did not move to the parent");
    const left = press("ArrowLeft");
    assert.equal(left.defaultPrevented, true, "ArrowLeft on an expanded branch was not handled");
    assert.deepEqual(s.expansionRequests, [{ status: "demo.s", tree: "t1", path: ["b"], expanded: false }]);
    assert.equal(focusName(), 'label ["b"]', "ArrowLeft on an expanded branch moved focus");
  } finally {
    s.body.remove();
  }
});

test("ArrowRight on an expanded branch keeps focus when no child has a focus target", async () => {
  const s = await keyboardSection("keys-no-child-target", tree([branch("f", [leaf("f1")], { command: "demo.open", expanded: true })]));
  try {
    focusOn(s, ["f"], "label");
    const right = press("ArrowRight");
    assert.equal(right.defaultPrevented, true, "ArrowRight on an expanded branch was not handled");
    assert.equal(focusName(), 'label ["f"]', "ArrowRight moved focus to a node with no focus target");
    assert.deepEqual(s.expansionRequests, [], "ArrowRight on an expanded branch requested a change");
  } finally {
    s.body.remove();
  }
});

test("ArrowRight on a leaf is not handled and keeps its default", async () => {
  const s = await keyboardSection("keys-leaf-right", tree(keyNodes()));
  try {
    focusOn(s, ["a"], "label");
    const right = press("ArrowRight");
    assert.equal(right.defaultPrevented, false, "ArrowRight on a leaf was handled");
    assert.equal(focusName(), 'label ["a"]', "ArrowRight on a leaf moved focus");
    assert.deepEqual(s.runs, [], "ArrowRight on a leaf ran a command");
  } finally {
    s.body.remove();
  }
});

test("a key with a modifier is not handled", async () => {
  const s = await keyboardSection("keys-modifier", tree(keyNodes()));
  try {
    focusOn(s, ["a"], "label");
    for (const modifier of ["shiftKey", "ctrlKey", "altKey", "metaKey"]) {
      const event = press("ArrowDown", { [modifier]: true });
      assert.equal(event.defaultPrevented, false, `ArrowDown with ${modifier} was handled`);
      assert.equal(focusName(), 'label ["a"]', `ArrowDown with ${modifier} moved focus`);
    }
    assert.deepEqual(s.runs, [], "a modifier key ran a command");
  } finally {
    s.body.remove();
  }
});

test("a node whose label is disabled has the expand control of its branch as focus target", async () => {
  const value = tree([
    leaf("x", { command: "demo.open" }),
    branch("g", [leaf("g1", { command: "demo.open" })], { command: "demo.open", enabled: false }),
  ]);
  const s = await keyboardSection("keys-disabled-label", value);
  try {
    focusOn(s, ["x"], "label");
    press("ArrowDown");
    assert.equal(focusName(), 'expand ["g"]', "the disabled label of a branch was used as focus target");
  } finally {
    s.body.remove();
  }
});

test("a redraw that removes the focused node moves focus to the nearest preceding node with a focus target", async () => {
  const s = await keyboardSection("keys-redraw-preceding", tree(keyNodes()));
  try {
    focusOn(s, ["c"], "expand");
    s.show(tree(keyNodes().filter((node) => node.key !== "c")));
    assert.equal(focusName(), 'label ["b","b1"]', "focus did not move to the nearest preceding node");
  } finally {
    s.body.remove();
  }
});

test("a redraw that removes the nearest preceding nodes moves focus to the nearest one that remains", async () => {
  const s = await keyboardSection("keys-redraw-remaining", tree(keyNodes()));
  try {
    focusOn(s, ["c"], "expand");
    s.show(tree(keyNodes().filter((node) => node.key !== "b" && node.key !== "c")));
    assert.equal(focusName(), 'label ["a"]', "focus did not skip the removed preceding nodes");
  } finally {
    s.body.remove();
  }
});

test("a redraw that removes the first node moves focus to the first node with a focus target", async () => {
  const s = await keyboardSection("keys-redraw-first", tree(keyNodes()));
  try {
    focusOn(s, ["a"], "label");
    s.show(tree([leaf("p", { command: "demo.open" }), leaf("q")]));
    assert.equal(focusName(), 'label ["p"]', "focus did not move to the first node with a focus target");
  } finally {
    s.body.remove();
  }
});

test("a redraw that leaves no node with a focus target moves focus to the document body", async () => {
  const s = await keyboardSection("keys-redraw-none", tree(keyNodes()));
  try {
    focusOn(s, ["a"], "label");
    s.show(tree([leaf("q")]));
    assert.equal(focusName(), "body", "focus stayed on a removed control");
  } finally {
    s.body.remove();
  }
});

test("a rejected value that removes the focused node moves focus to the document body", async () => {
  const s = await keyboardSection("keys-rejected", tree(keyNodes()));
  try {
    focusOn(s, ["a"], "label");
    s.show({ elements: [{ kind: "chart", key: "x" }] });
    assert.equal(focusName(), "body", "focus stayed on a removed control after a rejection");
  } finally {
    s.body.remove();
  }
});
