// Checks the input probe fixture (e2e/fixtures/input-probe/probe), the core fixture that carries the input checks of core in
// place of a real plugin (docs/spec/plugin-processes.md#verification-boundaries): its manifest satisfies the public installation
// contract and declares the statuses, commands and elements that the window checks read, its release holds the view page and
// the region document, and its input log reports keys, preedit, commits, caret, copy and paste in order.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { validateManifest } from "@soksak/plugin-api";

import { createInputLog } from "../fixtures/input-probe/probe/ui/input-log.js";

const PROBE = fileURLToPath(new URL("../fixtures/input-probe/probe/", import.meta.url));
const manifest = JSON.parse(readFileSync(join(PROBE, "plugin.json"), "utf8"));
const names = (list) => list.map((entry) => entry.name).sort();

test("the input probe manifest satisfies the public installation contract", { timeout: 5000 }, () => {
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.equal(manifest.id, "probeinput");
  assert.deepEqual(manifest.surface.composition.regions, [{ name: "text", kind: "document", input: "native" }]);
});

test("the input probe declares the statuses, commands and elements of the input checks", { timeout: 5000 }, () => {
  assert.deepEqual(names(manifest.exposes.status), ["probeinput.document", "probeinput.field", "probeinput.routing"]);
  assert.deepEqual(names(manifest.exposes.commands), ["probeinput.clear", "probeinput.clock", "probeinput.select"]);
  assert.deepEqual(names(manifest.exposes.element), ["probeinput.field", "probeinput.text"]);
  const status = Object.fromEntries(manifest.exposes.status.map((entry) => [entry.name, entry.schema.properties]));
  const input = ["documentTimeOriginMs", "focused", "value", "caret", "preedit", "keys", "commits", "copies", "pastes", "wheels",
    "pointer"];
  assert.deepEqual(Object.keys(status["probeinput.field"]), input);
  assert.deepEqual(Object.keys(status["probeinput.document"]), ["ready", ...input]);
  assert.deepEqual(Object.keys(status["probeinput.field"].keys.items.properties),
    ["sequence", "type", "key", "code", "modifiers", "text", "composing", "repeat", "trusted", "atMs"]);
  assert.deepEqual(Object.keys(status["probeinput.field"].wheels.items.properties), ["sequence", "deltaX", "deltaY", "modifiers", "atMs"]);
  assert.deepEqual(Object.keys(status["probeinput.field"].pointer.properties), ["downs", "drags", "ups", "foreign"]);
  assert.deepEqual(Object.keys(status["probeinput.routing"]), ["pickerOpen", "forwarded"]);
});

test("the input probe release holds its view page, its region document and the module of both", { timeout: 5000 }, () => {
  const pkg = JSON.parse(readFileSync(join(PROBE, "package.json"), "utf8"));
  assert.deepEqual(pkg.files, ["plugin.json", "ui"]);
  for (const file of [manifest.surface.composition.page, "ui/app.js", "ui/field.html", "ui/field.js", "ui/input-log.js"]) {
    assert.ok(existsSync(join(PROBE, file)), `${file} is missing`);
  }
  const app = readFileSync(join(PROBE, "ui/app.js"), "utf8");
  assert.match(app, /const PAGE = `soksak:\/\/\$\{PLUGIN\}\/ui\/field\.html`;/);
  assert.match(app, /const PLUGIN = "probeinput";/);
});

/** A document with a text field, in a jsdom window: the events and the selection of the field are those of jsdom. */
function textField() {
  const { window } = new JSDOM("<!doctype html><input id=field>", { url: "soksak://probeinput/" });
  const element = window.document.getElementById("field");
  element.focus();
  // The time of an event is its timeStamp, which a dispatched event takes from the clock; the event of a case carries the time of the case.
  const dispatch = (target, event, timeStamp) => {
    if (timeStamp !== undefined) Object.defineProperty(event, "timeStamp", { value: timeStamp });
    target.dispatchEvent(event);
  };
  const keyboard = (type, init, timeStamp) => dispatch(element, new window.KeyboardEvent(type, { bubbles: true, ...init }), timeStamp);
  const composition = (type, data, timeStamp) => dispatch(element, new window.CompositionEvent(type, { data }), timeStamp);
  const input = (init, timeStamp) => dispatch(element, new window.InputEvent("input", init), timeStamp);
  const clipboard = (type, text) => {
    const event = new window.Event(type);
    Object.defineProperty(event, "clipboardData", { value: { getData: (kind) => (kind === "text/plain" ? text : "") } });
    dispatch(element, event);
  };
  const documentEvent = (event, timeStamp) => dispatch(window.document, event, timeStamp);
  return { window, element, keyboard, composition, input, clipboard, documentEvent };
}

const key = (key, extra = {}) => ({ key, code: `Key${key.toUpperCase()}`, ...extra });

test("the input log reports keys in order with modifiers, text and arrival time", { timeout: 5000 }, () => {
  const { window, element, keyboard } = textField();
  const log = createInputLog(element, window);
  keyboard("keydown", key("a"), 10);
  keyboard("keyup", key("a"), 12);
  keyboard("keydown", key("c", { metaKey: true, shiftKey: true }), 20);
  const state = log.read();
  assert.equal(state.documentTimeOriginMs, window.performance.timeOrigin);
  assert.equal(state.focused, true);
  assert.deepEqual(state.keys.map(({ sequence, type, key: name, modifiers, text, atMs }) => ({ sequence, type, name, modifiers, text, atMs })), [
    { sequence: 1, type: "keydown", name: "a", modifiers: [], text: "a", atMs: 10 },
    { sequence: 2, type: "keyup", name: "a", modifiers: [], text: "", atMs: 12 },
    { sequence: 3, type: "keydown", name: "c", modifiers: ["shift", "command"], text: "", atMs: 20 },
  ]);
});

test("the input log reports the preedit and its range and one commit when a composition ends", { timeout: 5000 }, () => {
  const { window, element, composition, input } = textField();
  const log = createInputLog(element, window);
  element.value = "ab";
  element.setSelectionRange(2, 2);
  composition("compositionstart", "");
  composition("compositionupdate", "ㅎ");
  input({ inputType: "insertCompositionText", isComposing: true, data: "ㅎ" });
  composition("compositionupdate", "한");
  assert.deepEqual(log.read().preedit, { text: "한", start: 2, end: 3 });
  input({ inputType: "insertFromComposition", isComposing: true, data: "한" });
  composition("compositionend", "한", 30);
  input({ inputType: "insertText", isComposing: false, data: "x" }, 31);
  const state = log.read();
  assert.equal(state.preedit, null);
  assert.deepEqual(state.commits, [
    { sequence: 1, text: "한", composed: true, atMs: 30 },
    { sequence: 2, text: "x", composed: false, atMs: 31 },
  ]);
});

test("the input log reports the copied selection, the pasted text, the caret, and clears", { timeout: 5000 }, () => {
  const { window, element, clipboard } = textField();
  const log = createInputLog(element, window);
  const seen = [];
  log.subscribe((state) => seen.push(state.caret));
  log.select({ value: "EDITMENU", start: 0, end: 4 });
  clipboard("copy", "");
  clipboard("paste", "PASTED");
  let state = log.read();
  assert.deepEqual(state.caret, { start: 0, end: 4, direction: "none" });
  assert.deepEqual(state.copies.map((entry) => entry.text), ["EDIT"]);
  assert.deepEqual(state.pastes.map((entry) => entry.text), ["PASTED"]);
  assert.deepEqual(seen[0], { start: 0, end: 4, direction: "none" });
  log.clear();
  state = log.read();
  assert.equal(state.value, "");
  assert.deepEqual([state.keys, state.commits, state.copies, state.pastes, state.preedit], [[], [], [], [], null]);
  const clock = log.clock();
  assert.deepEqual([clock.documentTimeOriginMs, clock.sourceResolutionMs], [window.performance.timeOrigin, 1]);
  assert.ok(clock.sourceNowMs > 0 && clock.sourceNowMs <= window.performance.now(), "the source reading is a reading of the clock of the window");
});

test("the input log reports the wheels and the pointer gesture of its document, and a foreign button", { timeout: 5000 }, () => {
  const { window, element, documentEvent } = textField();
  const log = createInputLog(element, window);
  const pointer = (type, buttons) => documentEvent(new window.MouseEvent(type, { buttons }));
  documentEvent(new window.WheelEvent("wheel", { deltaX: 0, deltaY: -120, shiftKey: true }), 7);
  pointer("pointerdown", 1);
  pointer("pointermove", 1);
  pointer("pointermove", 1);
  pointer("pointerup", 0);
  pointer("pointermove", 2);
  let state = log.read();
  assert.deepEqual(state.wheels, [{ sequence: 1, deltaX: 0, deltaY: -120, modifiers: ["shift"], atMs: 7 }]);
  assert.deepEqual(state.pointer, { downs: 1, drags: 2, ups: 1, foreign: 1 });
  log.clear();
  state = log.read();
  assert.deepEqual([state.wheels, state.pointer], [[], { downs: 0, drags: 0, ups: 0, foreign: 0 }]);
});
