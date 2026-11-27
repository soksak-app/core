// The group 알림 of the page 동작 (docs/spec/notifications.md#settings): five common-only rows in the declared order, the delay indented
// and disabled while its switch is off, and its stepper bounded to 1 to 60 seconds with the default 5.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { beginSettings } from "../settings.js";
import { behaviorPage } from "../settings-pages.js";
import { GROUPS, rangeOf } from "../settings-rows.js";

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

const notices = () => GROUPS.behavior.find((group) => group.name === "알림");

function drawn(t, values = {}) {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  beginSettings({ common: values, projects: [] }, null);
  const root = dom.window.document.createElement("div");
  root.append(...behaviorPage());
  return root;
}

test("the group 알림 declares its five common-only rows in order, with the delay depending on its switch", () => {
  const rows = notices().rows;
  assert.deepEqual(rows.map((row) => row.key), ["toastStyle", "noticeCenterStyle", "quietToasts", "autoDismissProblemToasts", "problemToastDismissSeconds"]);
  for (const row of rows) assert.equal(row.scope, "common", `${row.key} is common only`);
  assert.equal(rows.at(-1).depends, "autoDismissProblemToasts");
  assert.deepEqual(rows.map((row) => row.form), ["choice", "choice", "switch", "switch", "stepper"]);
});

test("the delay stepper is bounded to 1 to 60 seconds", () => {
  assert.deepEqual(rangeOf("problemToastDismissSeconds"), [1, 60]);
});

test("the group draws its rows with their labels, and the delay is indented and disabled while the switch is off", (t) => {
  const root = drawn(t, { autoDismissProblemToasts: false });
  const group = [...root.querySelectorAll("section.set-group")].find((el) => el.querySelector(".set-group__name").textContent === "알림");
  assert.ok(group, "the group 알림 is drawn");
  const rows = [...group.querySelectorAll(":scope > .set-row")];
  assert.deepEqual(rows.map((row) => row.dataset.row), ["toastStyle", "noticeCenterStyle", "quietToasts", "autoDismissProblemToasts", "problemToastDismissSeconds"]);
  assert.deepEqual(rows.map((row) => row.querySelector(".set-row__name").textContent), ["토스트 모양", "알림 센터 모양", "조용히", "오류·경고 자동 닫힘", "닫힐 때까지"]);
  const delay = rows.at(-1);
  assert.equal(delay.classList.contains("set-row--indent"), true, "the delay row is indented");
  const controls = [...delay.querySelectorAll("input, button")];
  assert.ok(controls.length > 0 && controls.every((el) => el.disabled), "the delay is disabled while the switch is off");
});

test("the delay is enabled while the switch is on", (t) => {
  const root = drawn(t, { autoDismissProblemToasts: true });
  const group = [...root.querySelectorAll("section.set-group")].find((el) => el.querySelector(".set-group__name").textContent === "알림");
  const delay = [...group.querySelectorAll(":scope > .set-row")].at(-1);
  const controls = [...delay.querySelectorAll("input, button")];
  assert.ok(controls.length > 0 && controls.every((el) => !el.disabled), "the delay is enabled while the switch is on");
});
