// Checks the input probe fixture (e2e/fixtures/input-probe/probe), the core fixture that carries the input checks of core in
// place of a real plugin (docs/spec/plugin-processes.md#verification-boundaries): its manifest satisfies the public installation
// contract and declares the statuses, commands and elements that the window checks read, its release holds the view page and
// the region document, and its input log reports keys, preedit, commits, caret, copy and paste in order.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  const input = ["documentTimeOriginMs", "focused", "value", "caret", "preedit", "keys", "commits", "copies", "pastes"];
  assert.deepEqual(Object.keys(status["probeinput.field"]), input);
  assert.deepEqual(Object.keys(status["probeinput.document"]), ["ready", ...input]);
  assert.deepEqual(Object.keys(status["probeinput.field"].keys.items.properties),
    ["sequence", "type", "key", "code", "modifiers", "text", "composing", "repeat", "trusted", "atMs"]);
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

/** An object with addEventListener that keeps its listeners by type in on. */
const eventTarget = (members) => ({
  ...members,
  on: new Map(),
  addEventListener(type, fn) {
    if (!this.on.has(type)) this.on.set(type, []);
    this.on.get(type).push(fn);
  },
});

/** A text field with the events and the selection of an input element, and the window of its document. */
function fakeField() {
  const element = eventTarget({ value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none",
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    } });
  const document = eventTarget({ activeElement: element, hasFocus: () => true });
  const view = eventTarget({ document, performance: { timeOrigin: 1000, now: () => 5 } });
  const fire = (type, event = {}) => {
    // default: an event without a time arrives at time 0.
    for (const fn of element.on.get(type) ?? []) fn({ type, timeStamp: 0, ...event });
  };
  return { element, view, fire };
}

const key = (key, extra = {}) => ({ key, code: `Key${key.toUpperCase()}`, shiftKey: false, altKey: false, ctrlKey: false,
  metaKey: false, isComposing: false, keyCode: 0, repeat: false, isTrusted: true, ...extra });

test("the input log reports keys in order with modifiers, text and arrival time", { timeout: 5000 }, () => {
  const { element, view, fire } = fakeField();
  const log = createInputLog(element, view);
  fire("keydown", { ...key("a"), timeStamp: 10 });
  fire("keyup", { ...key("a"), timeStamp: 12 });
  fire("keydown", { ...key("c", { metaKey: true, shiftKey: true }), timeStamp: 20 });
  const state = log.read();
  assert.equal(state.documentTimeOriginMs, 1000);
  assert.equal(state.focused, true);
  assert.deepEqual(state.keys.map(({ sequence, type, key: name, modifiers, text, atMs }) => ({ sequence, type, name, modifiers, text, atMs })), [
    { sequence: 1, type: "keydown", name: "a", modifiers: [], text: "a", atMs: 10 },
    { sequence: 2, type: "keyup", name: "a", modifiers: [], text: "", atMs: 12 },
    { sequence: 3, type: "keydown", name: "c", modifiers: ["shift", "command"], text: "", atMs: 20 },
  ]);
});

test("the input log reports the preedit and its range and one commit when a composition ends", { timeout: 5000 }, () => {
  const { element, view, fire } = fakeField();
  const log = createInputLog(element, view);
  element.value = "ab";
  element.selectionStart = element.selectionEnd = 2;
  fire("compositionstart", { data: "" });
  fire("compositionupdate", { data: "ㅎ" });
  fire("input", { inputType: "insertCompositionText", isComposing: true, data: "ㅎ" });
  fire("compositionupdate", { data: "한" });
  assert.deepEqual(log.read().preedit, { text: "한", start: 2, end: 3 });
  fire("input", { inputType: "insertFromComposition", isComposing: true, data: "한" });
  fire("compositionend", { data: "한", timeStamp: 30 });
  fire("input", { inputType: "insertText", isComposing: false, data: "x", timeStamp: 31 });
  const state = log.read();
  assert.equal(state.preedit, null);
  assert.deepEqual(state.commits, [
    { sequence: 1, text: "한", composed: true, atMs: 30 },
    { sequence: 2, text: "x", composed: false, atMs: 31 },
  ]);
});

test("the input log reports the copied selection, the pasted text, the caret, and clears", { timeout: 5000 }, () => {
  const { element, view, fire } = fakeField();
  const log = createInputLog(element, view);
  const seen = [];
  log.subscribe((state) => seen.push(state.caret));
  log.select({ value: "EDITMENU", start: 0, end: 4 });
  fire("copy");
  fire("paste", { clipboardData: { getData: (type) => (type === "text/plain" ? "PASTED" : "") } });
  let state = log.read();
  assert.deepEqual(state.caret, { start: 0, end: 4, direction: "none" });
  assert.deepEqual(state.copies.map((entry) => entry.text), ["EDIT"]);
  assert.deepEqual(state.pastes.map((entry) => entry.text), ["PASTED"]);
  assert.deepEqual(seen[0], { start: 0, end: 4, direction: "none" });
  log.clear();
  state = log.read();
  assert.equal(state.value, "");
  assert.deepEqual([state.keys, state.commits, state.copies, state.pastes, state.preedit], [[], [], [], [], null]);
  assert.deepEqual(log.clock(), { documentTimeOriginMs: 1000, sourceNowMs: 5, sourceResolutionMs: 1 });
});
