import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mount } from "../ui/browser.js";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));

// 두 항목을 연 문서 영역. entry(offset) 는 받은 거리를 기록한다.
async function setup(t) {
  const dom = new JSDOM("<div id='mount'></div>", { url: "https://app.test/" });
  const root = dom.window.document.querySelector("#mount").attachShadow({ mode: "open" });
  const statuses = new Map(), commands = new Map(), states = new Set(), entries = [], titles = [];
  const region = {
    onState(fn) { states.add(fn); return () => states.delete(fn); },
    async load() {}, async entry(offset) { entries.push(offset); return true; },
    async back() {}, async forward() {}, async reload() {}, async stop() {}, async zoom() {},
  };
  const controller = await mount(root, {
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    runtime: { settings: { read: () => ({ home: "" }), on: () => () => {} }, textSize: { read: () => 1, on: () => () => {} } },
    surfaceId: "browser-history-test",
    tab: { title: (text) => titles.push(text) },
    composition: { async create() { return { region: () => region, async dispose() {} }; } },
    exposure: {
      status(name, read, subscribe) { statuses.set(name, { read, subscribe }); }, dom() {},
      command(name, run) { commands.set(name, run); },
      async bind() {}, async delegate() {}, async dispose() {},
    },
    status: { report() {} },
  });
  t.after(async () => { await controller.dispose(); dom.window.close(); });
  const send = (index) => {
    const history = { entries: [{ url: "https://a.test/one", title: "One" }, { url: "https://a.test/two", title: "Two" }], index };
    for (const fn of states) fn({ url: history.entries[index].url, title: history.entries[index].title, history,
      elements: { nodes: [], truncated: false }, requests: { entries: [], truncated: false } });
  };
  const state = (url, title) => { for (const fn of states) fn({ url, title, history: { entries: [], index: -1 },
    elements: { nodes: [], truncated: false }, requests: { entries: [], truncated: false } }); };
  return { statuses, commands, entries, send, titles, state };
}

test("the browser declares its session history status and the command that loads an entry", () => {
  assert.ok(manifest.exposes.status.some((entry) => entry.name === "browser.history"));
  assert.ok(manifest.exposes.commands.some((entry) => entry.name === "browser.history.go"));
});

test("browser.history follows the region state and browser.history.go loads an entry by its offset", { timeout: 10000 }, async (t) => {
  const { statuses, commands, entries, send } = await setup(t);
  const seen = [];
  statuses.get("browser.history").subscribe((value) => seen.push(value.index));
  assert.deepEqual(statuses.get("browser.history").read(), { entries: [], index: -1 });
  send(1);
  assert.equal(statuses.get("browser.history").read().entries.length, 2);
  assert.equal(statuses.get("browser.location").read().history, undefined, "browser.location does not carry the history");
  assert.equal(await commands.get("browser.history.go")({ index: 0 }), true);
  assert.deepEqual(entries, [-1]);
  assert.equal(await commands.get("browser.history.go")({ index: 1 }), false, "the current entry loads nothing");
  await assert.rejects(async () => commands.get("browser.history.go")({ index: 2 }), /outside the session history/);
  send(0);
  assert.equal(await commands.get("browser.history.go")({ index: 1 }), true);
  assert.deepEqual(entries, [-1, 1]);
  assert.deepEqual(seen, [-1, 1, 0]);
});

test("the tab title is the document title, or the address without one, and is removed without both", { timeout: 10000 }, async (t) => {
  const { titles, state } = await setup(t);
  state("https://a.test/one", "One");
  state("https://a.test/plain", "");
  state("https://a.test/long", `a\u0007b${"x".repeat(300)}`);
  state("", "");
  assert.deepEqual(titles.slice(-4), ["One", "https://a.test/plain", `ab${"x".repeat(254)}`, null]);
});
