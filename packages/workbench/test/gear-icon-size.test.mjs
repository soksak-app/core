// Every gear of the window is the declared settings icon in an icon switch (.act), so the title bar gear, the gear of the notice center and
// the gear of the settings tab chip are drawn at the icon size and stroke of the chrome tokens (docs/spec/notifications.md#notice-center,
// docs/spec/settings.md#opening-and-closing).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { beginSettings } from "../settings.js";
import { errorToasts } from "../shown-errors.js";
import { notificationStore } from "../tab-reports.js";
import { icon } from "../icons.js";
import { createSettingsChip } from "../settings-chip.js";

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));
const css = readFileSync(new URL("../app.css", import.meta.url), "utf8") + readFileSync(new URL("../home.css", import.meta.url), "utf8");

function page(t) {
  const dom = new JSDOM(`<head><style>${css}</style></head><body><div id="chip"></div><section id="tab"></section></body>`);
  t.after(() => dom.window.close());
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  return dom.window;
}

/** The size and stroke that reach the svg of a gear: the rules of the icon switch. */
function drawn(win, gear) {
  const svg = gear.querySelector("svg");
  assert.ok(svg, `${gear.className} draws the gear as text, not as the settings icon`);
  const declared = win.document.createElement("template");
  declared.innerHTML = icon("settings");
  assert.equal(svg.outerHTML, declared.content.firstElementChild.outerHTML, `${gear.className} draws another icon`);
  const style = win.getComputedStyle(svg);
  return { width: style.width, height: style.height, stroke: style.strokeWidth };
}

const titleBar = { width: "var(--act-icon)", height: "var(--act-icon)", stroke: "var(--act-stroke)" };

test("the gear of the notice center is the settings icon at the size of the title bar gear", (t) => {
  const win = page(t);
  beginSettings({ common: {}, projects: [] }, null);
  const store = notificationStore();
  errorToasts(document);
  if (!store.status().open) store.toggle();
  t.after(() => { if (store.status().open) store.toggle(); });
  const gear = document.querySelector('[data-expose="core.notices.settings"]');
  assert.ok(gear, "the notice center has no gear");
  assert.deepEqual(drawn(win, gear), titleBar);
});

test("the gear of the settings tab chip is the settings icon at the size of the title bar gear", (t) => {
  const win = page(t);
  createSettingsChip(document.getElementById("chip"), document.getElementById("tab"), { mount: () => {}, front: () => false, open: () => true }).draw();
  const chip = document.querySelector('[data-expose="core.settings-tab.chip"]');
  assert.equal(chip.textContent.trim(), "설정", "the chip names the tab 설정 beside its gear");
  assert.deepEqual(drawn(win, chip), titleBar);
});
