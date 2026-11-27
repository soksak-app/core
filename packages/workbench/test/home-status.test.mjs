// The status line of the project home (docs/spec/external-sidebars.md#status-bar): the number of projects, the open projects, the enabled
// and installed plugins, and the button back to the work screen, which is shown only while the window has one to return to.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createHomeStatusBar } from "../statusbar.js";

function fixture(t, { count = 3, open = 1, plugins = { enabled: 2, installed: 3 }, canReturn = true } = {}) {
  const dom = new JSDOM("<body><div id=\"bar\" hidden></div></body>");
  t.after(() => dom.window.close());
  const root = dom.window.document.getElementById("bar");
  const bar = createHomeStatusBar(root, { count: () => count, open: () => open, plugins: () => plugins, canReturn: () => canReturn });
  const text = (name) => root.querySelector(`[data-expose="${name}"]`);
  return { root, bar, text };
}

test("the home status line shows the projects, the open projects and the plugins as 프로젝트 n, 열림 n and 플러그인 a/b", (t) => {
  const { root, bar, text } = fixture(t);
  bar.draw(true);
  assert.equal(root.hidden, false);
  assert.equal(text("core.home.status.projects").textContent, "프로젝트 3");
  assert.equal(text("core.home.status.open").textContent, "열림 1");
  assert.equal(text("core.home.status.plugins").textContent, "플러그인 2/3");
});

test("the button back to the work screen is shown only while the window has a work screen to return to", (t) => {
  const { bar, text } = fixture(t, { canReturn: false });
  bar.draw(true);
  assert.equal(text("core.home.status.back").hidden, true);
});

test("the home status line is hidden when it is not drawn", (t) => {
  const { root, bar } = fixture(t);
  bar.draw(false);
  assert.equal(root.hidden, true);
});
