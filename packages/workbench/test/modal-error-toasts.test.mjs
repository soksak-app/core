import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { recordsOf } from "./support/records.mjs";

test("the debug copy shares the foreground toast of the window and forwards its close once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wire = selectPageWire("error-toast-debug");
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
    const toast = root.querySelector(".toast");
    assert.equal(root.querySelectorAll('[data-expose="core.notices.close"]').length, 1, `the native ${id} copy must have one close control`);
    // The title is the message, with the count of its merged occurrences after it (docs/spec/notifications.md#toasts).
    assert.match(toast.querySelector(".toast__title").textContent, new RegExp(`^${message}( ×\\d+)?$`));
    assert.equal(document.querySelectorAll(".toast__close").length, 1);
    assert.equal(document.querySelector(`#${id} .toast`)?.closest('[role="dialog"]')?.id, id);
    // The close control is the one that answers with the key of the notice; the actions of the toast come before it.
    return toast.querySelector(".toast__close");
  }

  // The settings tab shows the error in the toast of the window, and opens no copy.
  assert.ok(document.querySelector("body > #toasts .toast"));

  errors.withdraw("layout");
  assert.equal(errors.newest(), message);
  await debug.openDebug();
  assert.equal(debug.debugState().recorded, "logs/state.json");
  // The state and file listing can finish while the native modal is opening. Its ordered updates wait for that reply.
  wire.release("overlayShow");
  await orderedCallsAnswered();
  const previous = copied("overlayUpdate", "debug");
  const previousKey = previous.dataset.key;
  // The common settings turn on the automatic dismissal, as a settings snapshot of the host does.
  (await import("../settings.js")).beginSettings({ common: { autoDismissProblemToasts: true, problemToastDismissSeconds: 4 }, projects: [] }, null);
  let dismissals = 0;
  registry.watch((name) => { if (name === "core.notices.close") dismissals++; });
  const answers = [];
  onAnswer(copy.window.document, (key, value) => answers.push({ key, value }));
  t.mock.timers.tick(4000);
  await orderedCallsAnswered();
  assert.equal(errors.newest(), null);
  errors.withdraw("activity");
  source("activity");
  await orderedCallsAnswered();
  assert.equal(errors.newest(), message);

  // The copied document can still have the old control until it processes the newer overlay updates.
  previous.click();
  assert.deepEqual(answers, [{ key: previousKey, value: "" }]);
  wire.deliverNotice();
  assert.equal(dismissals, 0, "the obsolete key did not issue a dismiss command for the newer occurrence");
  assert.equal(errors.newest(), message);
  assert.throws(() => wire.deliverNotice(), /debug control missing debug key is not in the card/);

  const button = copied("overlayUpdate", "debug");
  assert.notEqual(button.dataset.key, previousKey);
  button.click();
  assert.deepEqual(answers.at(-1), { key: button.dataset.key, value: "" });
  wire.deliverNotice();
  await registry.commandsEnded();
  await orderedCallsAnswered();
  assert.equal(dismissals, 1);
  const update = wire.calls.findLast(({ name, payload }) => name === "overlayUpdate" && payload.id === "debug");
  updateContent(root, update.payload.html);
  assert.equal(root.querySelector(".toast"), null, "the copied toast is removed when dismissed");
  assert.equal(errors.text("activity"), message);
  source("activity");

  debug.closeDebug();
  await keyboardIdle();
  await orderedCallsAnswered();
  assert.equal(document.querySelector(".toast"), null);
  await flushEvents();
  assert.deepEqual(wire.calls.flatMap(({ name, payload }) => recordsOf(name, payload)), [
    { level: "error", where: "layout origin", text: message },
    { level: "error", where: "activity origin", text: message },
    { level: "error", where: "activity origin", text: message },
  ]);
  wire.finish();
});
