// The settings tab chip beside the project tabs: it is shown while the window has a settings tab, mounts the settings content once
// when the tab is in front, and its close control runs core.settings.close (docs/spec/settings.md#opening-and-closing).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import exposureFile from "../exposure.json" with { type: "json" };

const dom = new JSDOM('<!doctype html><body><div id="chip"></div><section id="content" hidden></section></body>', { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { installExposure } = await import("../exposure.js");
const { createSettingsChip } = await import("../settings-chip.js");
installExposure(exposureFile);

function build(state) {
  const mounts = [];
  const chip = createSettingsChip(document.getElementById("chip"), document.getElementById("content"), {
    mount: (container) => { mounts.push(container); },
    front: () => state.front,
    open: () => state.open,
  });
  return { chip, mounts };
}

test("the chip is hidden without a settings tab and shows the label with its close control when the tab is open", () => {
  const state = { open: false, front: false };
  const { chip } = build(state);
  chip.draw();
  const root = document.getElementById("chip");
  assert.equal(root.hidden, true, "no settings tab, no chip");
  state.open = true;
  chip.draw();
  assert.equal(root.hidden, false);
  const open = root.querySelector('[data-expose="core.settings-tab.chip"]');
  assert.equal(open.textContent, "⚙ 설정");
  assert.equal(open.dataset.command, "core.settings.open");
  const close = root.querySelector('[data-expose="core.settings-tab.close"]');
  assert.equal(close.dataset.command, "core.settings.close");
});

test("the content is mounted once, when the settings tab is in front, and is hidden otherwise", () => {
  const state = { open: true, front: false };
  const { chip, mounts } = build(state);
  chip.draw();
  assert.equal(mounts.length, 0, "a settings tab behind the work screen is not mounted");
  assert.equal(document.getElementById("content").hidden, true);
  state.front = true;
  chip.draw();
  chip.draw();
  assert.equal(mounts.length, 1, "the content is mounted once");
  assert.equal(mounts[0], document.getElementById("content"));
  assert.equal(document.getElementById("content").hidden, false);
  assert.equal(chip.state().front, true);
  state.front = false;
  chip.draw();
  assert.equal(document.getElementById("content").hidden, true);
});

test("the chip refuses to draw without the functions of the settings module", () => {
  assert.throws(() => createSettingsChip(document.getElementById("chip"), document.getElementById("content"), { mount() {}, front() {} }),
    /needs the mount, front and open functions/);
});

test("after the settings tab is closed, the work screen shows the hint with its open button until the tab opens again", () => {
  const hint = document.createElement("div");
  hint.id = "closedHint";
  hint.hidden = false;
  document.body.append(hint);
  const state = { open: false, front: false };
  const chip = createSettingsChip(document.getElementById("chip"), document.getElementById("content"), {
    mount() {}, front: () => state.front, open: () => state.open, hint,
  });
  chip.draw(true);
  assert.equal(hint.hidden, true, "a window that never opened the settings tab shows the hint");
  state.open = true;
  state.front = true;
  chip.draw(true);
  assert.equal(hint.hidden, true, "the hint shows while the settings tab is in front");
  state.open = false;
  state.front = false;
  chip.draw(true);
  assert.equal(hint.hidden, false, "the closed settings tab shows no hint");
  assert.equal(chip.state().closed, true);
  const reopen = hint.querySelector('[data-expose="core.settings-tab.reopen"]');
  assert.equal(hint.textContent.includes("설정이 닫혀 있다"), true);
  assert.equal(reopen.textContent, "설정 열기");
  assert.equal(reopen.dataset.command, "core.settings.open");
  chip.draw(false);
  assert.equal(hint.hidden, true, "the project home or a window without a work screen shows no hint");
  chip.draw(true);
  assert.equal(hint.hidden, false);
  state.open = true;
  state.front = true;
  chip.draw(true);
  assert.equal(hint.hidden, true, "the hint stays after the tab opens again");
  hint.remove();
});
