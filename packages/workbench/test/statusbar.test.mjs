// The status bar of the main window shows the project name, the card count, the theme and the mode, each read from its status, and
// the key hint of the settings (docs/spec/external-sidebars.md#status-bar). These tests draw it into a document of its own.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createStatusBar } from "../statusbar.js";

function build(values) {
  const { document } = new JSDOM('<div id="bar" hidden></div>').window;
  globalThis.document = document;
  const root = document.getElementById("bar");
  const bar = createStatusBar(root, {
    project: () => values.project,
    cards: () => values.cards,
    theme: () => values.theme,
    mode: () => values.mode,
  });
  const texts = () => [...root.querySelectorAll(".statusbar__item")].filter((item) => !item.hidden).map((item) => item.textContent);
  return { root, bar, texts };
}

test("the status bar shows the project, the card count, the theme and the mode of the window", () => {
  const { root, bar, texts } = build({ project: { title: "project1" }, cards: 2, theme: "midnight", mode: "dark" });
  bar.draw(true);
  assert.equal(root.hidden, false);
  assert.deepEqual(texts(), ["project1", "카드 2", "midnight · dark"]);
  assert.equal(root.querySelector('[data-expose="core.statusbar.project"]').textContent, "project1");
  assert.equal(root.querySelector('[data-expose="core.statusbar.cards"]').textContent, "카드 2");
  assert.equal(root.querySelector('[data-expose="core.statusbar.theme"]').textContent, "midnight · dark");
  assert.equal(root.querySelector(".statusbar__key").textContent, "⌘, 설정", "the key hint of the settings is missing");
});

test("the status bar follows each change of its statuses on the next draw", () => {
  const values = { project: { title: "project1" }, cards: 2, theme: "midnight", mode: "dark" };
  const { bar, texts } = build(values);
  bar.draw(true);
  values.cards = 3;
  values.theme = "slate";
  values.project = { title: "soksak" };
  bar.draw(true);
  assert.deepEqual(texts(), ["soksak", "카드 3", "slate · dark"]);
});

test("the status bar holds no project name without a project and is hidden when it is not drawn", () => {
  const { root, bar, texts } = build({ project: null, cards: 0, theme: "midnight", mode: "dark" });
  bar.draw(true);
  assert.deepEqual(texts(), ["카드 0", "midnight · dark"], "a window without a project shows a project name");
  bar.draw(false);
  assert.equal(root.hidden, true, "the bar stays visible on the project home");
});
