// The icon of an activity before a name (docs/spec/activity.md#drawing): drawActivity of activity.js, which the tabs of the cards, the
// group headers and the project and space tabs use.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { drawActivity } from "../activity.js";
import declaration from "../workbench.json" with { type: "json" };

/** A group header with its name, as createGroupCard of group-cards.js makes it. */
function header() {
  const { document } = new JSDOM(`<header class="group__head"><span class="group__name">outer</span><span class="chrome__acts"></span></header>`).window;
  globalThis.document = document;
  const head = document.querySelector(".group__head");
  return { head, name: head.querySelector(".group__name") };
}

test("each activity draws its declared icon as an image named by the activity before the name", () => {
  for (const [activity, label] of Object.entries({ attention: "응답 대기", failed: "실패", running: "실행 중", idle: "유휴" })) {
    const { head, name } = header();
    drawActivity(head, name, activity, "core.activity.group");
    const icon = head.querySelector(".activity");
    assert.equal(icon.nextElementSibling, name, `the icon of ${activity} does not stand before the name`);
    assert.deepEqual([icon.dataset.expose, icon.dataset.activity, icon.getAttribute("role"), icon.getAttribute("aria-label"), icon.title],
      ["core.activity.group", activity, "img", label, label]);
    assert.equal(icon.querySelector("svg").getAttribute("viewBox"), "0 0 16 16");
    const declared = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    declared.innerHTML = declaration.icons[`activity-${activity}`];
    assert.equal(icon.querySelector("svg").innerHTML, declared.innerHTML);
  }
});

test("a change of activity redraws the one icon, an unchanged activity keeps it, and no activity removes it", () => {
  const { head, name } = header();
  drawActivity(head, name, "running", "core.activity.group");
  const icon = head.querySelector(".activity");
  const drawn = icon.querySelector("svg");
  drawActivity(head, name, "running", "core.activity.group");
  assert.equal(icon.querySelector("svg"), drawn, "an unchanged activity drew its icon again");
  drawActivity(head, name, "failed", "core.activity.group");
  assert.deepEqual([head.querySelectorAll(".activity").length, head.querySelector(".activity"), icon.dataset.activity, icon.title], [1, icon, "failed", "실패"]);
  drawActivity(head, name, null, "core.activity.group");
  assert.equal(head.querySelector(".activity"), null);
});
