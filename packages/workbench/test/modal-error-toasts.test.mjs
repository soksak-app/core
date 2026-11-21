import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { recordsOf } from "./support/records.mjs";

test("the native settings and debug copies share the foreground toast and forward its close once", async (t) => {
  const wire = selectPageWire("error-toast-modal");
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  const copy = new JSDOM('<body><div role="dialog" id="copy"></div></body>');
  const { window } = dom;
  const { document } = window;
  window.matchMedia = (query) => ({ media: query, matches: true, addEventListener() {}, removeEventListener() {} });
  Object.assign(globalThis, {
    window, document, CSS: { escape: (value) => value }, innerWidth: 800, innerHeight: 600,
    addEventListener: window.addEventListener.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
  });
  document.adoptedStyleSheets = [];
  const style = document.createElement("style");
  style.textContent = ".set-card { border-top-color: rgb(1, 2, 3); background-color: rgb(4, 5, 6); }";
  document.head.append(style);
  t.after(() => { dom.window.close(); copy.window.close(); });
  const { installExposure, registry } = await import("../exposure.js");
  installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));
  const { installErrorExposure } = await import("../core-exposure.js");
  const errors = installErrorExposure();
  const { orderedCallsAnswered } = await import("../host.js");
  const { idle: keyboardIdle } = await import("../keyboard.js");
  const { flushEvents } = await import("../page-log.js");
  const { onAnswer } = await import("../card.js");
  const { updateContent } = await import("../overlay-content.js");
  const settings = await import("../settings-ui.js");
  const debug = await import("../debug-ui.js");

  const message = "The workspace could not be saved";
  const source = (origin) => errors.show(message, "", origin, `${origin} origin`);
  source("layout");
  source("activity");
  await flushEvents();

  const root = copy.window.document.querySelector("#copy");
  function copied(name, id) {
    const call = wire.calls.findLast(({ name: method, payload }) => method === name && payload.id === id);
    assert.ok(call, `the native ${id} document was not sent`);
    updateContent(root, call.payload.html);
    const toast = root.querySelector(".error-toast");
    assert.equal(root.querySelectorAll('[data-expose="core.error.dismiss"]').length, 1, `the native ${id} copy must have one close control`);
    assert.equal(toast.querySelector(".error-toast__text").textContent, message);
    assert.equal(document.querySelectorAll(".error-toast__close").length, 1);
    assert.equal(document.querySelector(`#${id} .error-toast`)?.closest('[role="dialog"]')?.id, id);
    return toast.querySelector("button");
  }

  settings.openSettings();
  await orderedCallsAnswered();
  copied("overlayShow", "settings");
  settings.closeSettings();
  await keyboardIdle();
  await orderedCallsAnswered();
  assert.ok(document.querySelector("body > #errorToasts .error-toast"));

  errors.withdraw("layout");
  assert.equal(errors.newest(), message);
  await debug.openDebug();
  assert.equal(debug.debugState().recorded, "logs/state.json");
  // The state and file listing can finish while the native modal is opening. Its ordered updates wait for that reply.
  wire.release("overlayShow");
  await orderedCallsAnswered();
  const button = copied("overlayUpdate", "debug");
  let dismissals = 0;
  registry.watch((name) => { if (name === "core.error.dismiss") dismissals++; });
  const answers = [];
  onAnswer(copy.window.document, (key, value) => answers.push({ key, value }));
  button.click();
  assert.deepEqual(answers, [{ key: button.dataset.key, value: "" }]);
  wire.deliverNotice();
  await registry.commandsEnded();
  await orderedCallsAnswered();
  assert.equal(dismissals, 1);
  const update = wire.calls.findLast(({ name, payload }) => name === "overlayUpdate" && payload.id === "debug");
  updateContent(root, update.payload.html);
  assert.equal(root.querySelector(".error-toast"), null, "the copied toast is removed when dismissed");
  assert.equal(errors.text("activity"), message);
  source("activity");

  debug.closeDebug();
  await keyboardIdle();
  await orderedCallsAnswered();
  assert.equal(document.querySelector(".error-toast"), null);
  await flushEvents();
  assert.deepEqual(wire.calls.flatMap(({ name, payload }) => recordsOf(name, payload)), [
    { level: "error", where: "layout origin", text: message },
    { level: "error", where: "activity origin", text: message },
  ]);
  wire.finish();
});
