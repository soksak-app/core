// The card status line of the content footer shows the newest notice of the card with its text, kind and close control
// (docs/spec/notifications.md#card-status-line).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const { registry } = await import("../exposure.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { cardNoticeLine } = await import("../notice-view.js");

const dom = new JSDOM("<main></main>");
const { document } = dom.window;

test("the card status line carries the kind, the title, the text and a close control bound to core.notices.close", () => {
  const notice = { id: "notice-3", kind: "warning", base: "Disk full", text: "Free 2 GB", actions: [] };
  const line = cardNoticeLine(document, null, notice);
  assert.equal(line.dataset.notice, "notice-3");
  assert.equal(line.dataset.kind, "warning");
  assert.equal(line.dataset.expose, "core.card.notice");
  assert.equal(line.querySelector(".notice-line__title").textContent, "Disk full");
  assert.equal(line.querySelector(".notice-line__text").textContent, "Free 2 GB");
  const close = line.querySelector(".notice-line__close");
  assert.equal(close.dataset.expose, "core.notices.close");
  assert.equal(line.getAttribute("role"), "status");
});

test("an error status line is an alert, and an empty text adds no text element", () => {
  const notice = { id: "notice-4", kind: "error", base: "Build failed", text: "", actions: [] };
  const line = cardNoticeLine(document, null, notice);
  assert.equal(line.getAttribute("role"), "alert");
  assert.equal(line.querySelector(".notice-line__text"), null);
});

test("the card status line reads dot, title, text, first action and close, separated by middots", () => {
  const notice = { id: "notice-5", kind: "info", base: "Disk full", text: "Free 2 GB", actions: [{ label: "Retry", command: "core.notices.toggle", params: {} }] };
  const line = cardNoticeLine(document, null, notice);
  assert.equal(line.textContent, "Disk full · Free 2 GB · [Retry] · ×", "the line format of docs/spec/notifications.md#card-status-line");
});

test("the card status line shows only the first of its actions", () => {
  const notice = { id: "notice-6", kind: "warning", base: "Waits", text: "", actions: [
    { label: "First", command: "core.notices.toggle", params: {} }, { label: "Second", command: "core.notices.toggle", params: {} }] };
  const line = cardNoticeLine(document, null, notice);
  assert.deepEqual([...line.querySelectorAll(".notice-line__action")].map((b) => b.textContent), ["[First]"]);
});

test("a notice of a tab that is not the active tab of its card names the tab before its title", () => {
  const notice = { id: "notice-7", kind: "warning", base: "Build failed", text: "", actions: [] };
  const line = cardNoticeLine(document, null, notice, "Shell");
  assert.ok(line.textContent.startsWith("Shell · Build failed"), `found ${line.textContent}`);
  assert.equal(cardNoticeLine(document, null, notice).textContent.startsWith("Build failed"), true, "no tab name without the parameter");
});
