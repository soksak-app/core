import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createBinder } from "@soksak/plugin-api";
import { mount } from "../ui/browser.js";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));

// 주소가 없는 표면을 마운트한다. region.load 는 받은 주소를 상태로 알린다.
async function setup(t) {
  const dom = new JSDOM("<div id='mount'></div>", { url: "https://app.test/" });
  const root = dom.window.document.querySelector("#mount").attachShadow({ mode: "open" });
  const commands = new Map(), requests = [], states = new Set(), doms = new Map();
  const binder = createBinder((name, params) => {
    requests.push(name);
    return commands.get(name)(params);
  }, { check(name) { assert.ok(manifest.exposes.commands.some((entry) => entry.name === name), `undeclared command ${name}`); } });
  const region = {
    onState(fn) { states.add(fn); return () => states.delete(fn); },
    async load(url) { for (const fn of states) fn({ url, title: url, history: { entries: [], index: -1 }, elements: { nodes: [], truncated: false }, requests: { entries: [], truncated: false } }); },
    async back() {}, async forward() {}, async reload() {}, async stop() {}, async zoom() {},
  };
  const controller = await mount(root, {
    runtime: { settings: { read: () => ({ home: "" }), on: () => () => {} }, textSize: { read: () => 1, on: () => () => {} } },
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    tab: { title() {} },
    surfaceId: "browser-empty-test",
    composition: { async create() { return { region: () => region, async dispose() {} }; } },
    exposure: {
      status() {}, dom(name, element) { doms.set(name, element); }, command(name, run) { commands.set(name, run); },
      bind: binder.bind, delegate: binder.delegate, dispose: binder.dispose,
    },
    status: { report() {} },
  });
  t.after(async () => { await controller.dispose(); dom.window.close(); });
  return { dom, root, requests, doms, commands };
}

test("an empty address hides the document element and shows the declared empty state", { timeout: 10000 }, async (t) => {
  const { root, doms } = await setup(t);
  assert.ok(manifest.exposes.dom.some((entry) => entry.name === "browser.empty"), "browser.empty is not declared");
  const empty = root.querySelector('[data-expose="browser.empty"]');
  assert.ok(empty, "the empty state element is missing");
  assert.equal(doms.get("browser.empty"), empty);
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, "주소를 입력하세요");
  assert.equal(root.querySelector("#document").hidden, true, "the document element must be hidden without an address");
});

test("clicking the empty state focuses the address through browser.address.select", { timeout: 10000 }, async (t) => {
  const { dom, root, requests } = await setup(t);
  const empty = root.querySelector('[data-expose="browser.empty"]');
  assert.equal(empty.dataset.command, "browser.address.select");
  empty.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, composed: true }));
  assert.ok(requests.includes("browser.address.select"));
  assert.equal(root.activeElement, root.querySelector("#address"));
});

test("a loaded address removes the empty state and shows the document element", { timeout: 10000 }, async (t) => {
  const { root, commands } = await setup(t);
  await commands.get("browser.navigate")({ url: "https://example.test/" });
  assert.equal(root.querySelector('[data-expose="browser.empty"]').hidden, true);
  assert.equal(root.querySelector("#document").hidden, false);
});
