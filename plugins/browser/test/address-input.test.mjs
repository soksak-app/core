import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createBinder } from "@soksak/plugin-api";
import { mount } from "../ui/browser.js";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));

async function setup(t) {
  const dom = new JSDOM("<button id='outside'>outside</button><div id='mount'></div>", { url: "https://app.test/" });
  const root = dom.window.document.querySelector("#mount").attachShadow({ mode: "open" });
  const commands = new Map(), requests = [], states = new Set();
  const binder = createBinder((name, params) => {
    requests.push(name);
    assert.ok(commands.has(name), `unregistered command ${name}`);
    return commands.get(name)(params);
  }, { check(name) { assert.ok(manifest.exposes.commands.some((entry) => entry.name === name), `undeclared command ${name}`); } });
  const navigations = [];
  const region = {
    onState(fn) { states.add(fn); return () => states.delete(fn); },
    async load(url) { navigations.push(url); for (const fn of states) fn({ url, title: url, history: { entries: [], index: -1 }, elements: { nodes: [], truncated: false }, requests: { entries: [], truncated: false } }); },
    async back() {}, async forward() {}, async reload() {}, async stop() {}, async zoom() {},
  };
  const controller = await mount(root, {
    runtime: { settings: { read: () => ({ home: "https://example.test/old" }), on: () => () => {} }, textSize: { read: () => 1, on: () => () => {} } },
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    tab: { title() {} },
    surfaceId: "browser-address-test",
    composition: { async create() { return { region: () => region, async dispose() {} }; } },
    exposure: {
      status() {}, dom() {}, command(name, run) { commands.set(name, run); },
      bind: binder.bind, delegate: binder.delegate, dispose: binder.dispose,
    },
    status: { report(phase) { assert.equal(phase, "ready"); } },
  });
  t.after(() => dom.window.close());
  const address = root.querySelector("#address");
  const dispatch = (type) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, composed: true });
    address.dispatchEvent(event);
    return event;
  };
  return { dom, root, address, requests, navigations, controller, dispatch, commands, states };
}

test("initial address focus selects all and native replacement navigates without appending", { timeout: 10000 }, async (t) => {
  const { dom, address, requests, navigations, controller, dispatch } = await setup(t);
  t.after(() => controller.dispose());
  dispatch("pointerdown");
  address.focus();
  assert.deepEqual([address.selectionStart, address.selectionEnd], [0, address.value.length]);
  assert.equal(dispatch("mouseup").defaultPrevented, true, "initial release must retain selection");
  assert.equal(requests.filter((name) => name === "browser.address.select").length, 1);
  address.setRangeText("https://example.test/new", address.selectionStart, address.selectionEnd, "end");
  address.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(navigations, ["https://example.test/old", "https://example.test/new"]);
});

test("subsequent address clicks preserve caret editing and disposal removes handlers", { timeout: 10000 }, async (t) => {
  const { dom, address, requests, controller, dispatch } = await setup(t);
  address.focus();
  assert.deepEqual([address.selectionStart, address.selectionEnd], [0, address.value.length]);
  address.setSelectionRange(4, 4);
  dispatch("pointerdown");
  assert.equal(dispatch("mouseup").defaultPrevented, false, "later clicks retain normal caret placement");
  assert.deepEqual([address.selectionStart, address.selectionEnd], [4, 4]);
  dom.window.document.querySelector("#outside").focus();
  dispatch("pointerdown");
  address.focus();
  assert.equal(dispatch("mouseup").defaultPrevented, true);
  assert.equal(requests.filter((name) => name === "browser.address.select").length, 2);
  await controller.dispose();
  dispatch("pointerdown");
  address.dispatchEvent(new dom.window.FocusEvent("focus"));
  assert.equal(dispatch("mouseup").defaultPrevented, false, "disposed handlers must not cancel input");
  assert.equal(requests.filter((name) => name === "browser.address.select").length, 2);
});

test("a navigation that did not come from typing shows its address in the focused field", { timeout: 10000 }, async (t) => {
  const { dom, root, address, controller, commands, states } = await setup(t);
  t.after(() => controller.dispose());
  const type = (text) => {
    address.value = text;
    address.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  address.focus();
  type("https://example.test/typed");
  address.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await Promise.resolve();
  assert.equal(root.activeElement, address, "the field keeps focus after Enter");
  await commands.get("browser.navigate")({ url: "https://example.test/other" });
  assert.equal(address.value, "https://example.test/other");
  // 입력 중인 글자는 이동이 아닌 문서 상태 변화로 바뀌지 않는다.
  type("https://example.test/oth");
  for (const fn of states) fn({ url: "https://example.test/other", title: "scrolled", history: { entries: [], index: -1 }, elements: { nodes: [], truncated: false }, requests: { entries: [], truncated: false } });
  assert.equal(address.value, "https://example.test/oth");
  await commands.get("browser.back")({});
  for (const fn of states) fn({ url: "https://example.test/typed", title: "back", history: { entries: [], index: -1 }, elements: { nodes: [], truncated: false }, requests: { entries: [], truncated: false } });
  assert.equal(address.value, "https://example.test/typed");
});
