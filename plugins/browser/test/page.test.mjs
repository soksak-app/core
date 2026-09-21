import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { INTERACTIVE } from "@soksak/plugin-api";

const source = readFileSync(new URL("../ui/browser.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const { document } = new JSDOM("<div></div>").window;
const names = (kind) => manifest.exposes[kind].map((entry) => entry.name);

test("browser module is an app-DOM entry", () => {
  assert.match(source, /export (?:async )?function mount/);
});

test("every control names a declared dom entry and a declared command", () => {
  assert.match(source, /data-expose="browser.address/);
  assert.match(source, /data-command="browser.reload/);
  assert.ok(names("dom").length > 0);
});

test("the document region is a declared dom entry and the start address is home", () => {
  assert.match(source, /browser.document/);
  assert.match(manifest.home, /^https:\/\//);
  assert.deepEqual(names("commands"), ["browser.address.select", "browser.navigate", "browser.back", "browser.forward", "browser.reload", "browser.stop"]);
  assert.deepEqual(names("status"), ["browser.location"]);
});

test("browser mount publishes document state, respects shadow focus, and disposes every port", async () => {
  const dom = new JSDOM("<div></div>", { url: "https://example.test/" });
  const root = dom.window.document.createElement("div");
  const shadow = root.attachShadow({ mode: "open" });
  const states = [];
  const exposed = { statuses: new Map(), commands: new Map(), doms: new Map(), disposed: false };
  const region = {
    onState(fn) { states.push(fn); return () => { states.splice(states.indexOf(fn), 1); }; },
    load: async (url) => { states.forEach((fn) => fn({ url, title: "loaded" })); },
    back: async () => {}, forward: async () => {}, reload: async () => {}, stop: async () => {},
  };
  const composition = {
    region: () => region,
    dispose: async () => { composition.disposed = true; },
  };
  const context = {
    metadata: { home: "https://home.test/" },
    composition: { create: async () => composition },
    exposure: {
      status: async (name, read, subscribe) => exposed.statuses.set(name, { read, subscribe }),
      command: async (name, fn) => exposed.commands.set(name, fn),
      dom: async (name, element) => exposed.doms.set(name, element),
      delegate: async () => {}, bind: async () => {},
      dispose: async () => { exposed.disposed = true; },
    },
    status: { report: (phase) => { exposed.phase = phase; } },
  };
  const { mount } = await import("../ui/browser.js");
  const mounted = await mount(shadow, context);
  const address = shadow.querySelector("#address");
  address.focus();
  Object.defineProperty(shadow, "activeElement", { configurable: true, value: address });
  states[0]({ url: "https://changed.test/", title: "changed" });
  assert.equal(address.value, "https://home.test/", "focused ShadowRoot input is not overwritten");
  const watchValues = [];
  const stopWatch = exposed.statuses.get("browser.location").subscribe((value) => watchValues.push(value.url));
  states[0]({ url: "https://next.test/" });
  assert.equal(exposed.statuses.get("browser.location").read().url, "https://next.test/");
  assert.deepEqual(watchValues, ["https://changed.test/", "https://next.test/"]);
  stopWatch();
  await mounted.dispose();
  assert.equal(composition.disposed, true);
  assert.equal(exposed.disposed, true);
  assert.equal(states.length, 0);
  assert.equal(shadow.childNodes.length, 0);
  dom.window.close();
});
