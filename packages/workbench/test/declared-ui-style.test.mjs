import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const elements = [
  { kind: "status-line", key: "project", text: "/project" },
  { kind: "button", key: "add", label: "Add", command: "demo.add" },
  { kind: "tree", key: "files", empty: "none", nodes: [{ key: "directory", label: "directory", command: "demo.select",
    branch: true, expanded: false, actions: [{ key: "remove", label: "Remove", command: "demo.remove" }] }] },
  { kind: "list", key: "bookmarks", empty: "none", items: [{ key: "file", label: "/project/file", command: "demo.remove" }] },
];

async function draw(t, name) {
  const previous = globalThis.document;
  const dom = new JSDOM(`<style>${css}</style><body><div class="set__body" data-declared></div></body>`);
  globalThis.document = dom.window.document;
  t.after(() => {
    globalThis.document = previous;
    dom.window.close();
  });
  const { drawValue } = await import(`../declared-ui.js?${name}`);
  const body = dom.window.document.querySelector(".set__body");
  drawValue(body, elements, {
    statusId: "demo.tree",
    bind: () => {},
    expandedByTree: new Map([["files", new Map([[JSON.stringify(["directory"]), false]])]]),
  });
  return { dom, body };
}

test("a declared tree body adds no padding around its tree", async (t) => {
  const { dom, body } = await draw(t, "body-padding");
  const style = dom.window.getComputedStyle(body);
  assert.equal(style.paddingTop, "0px", "a declared tree body adds top padding around the tree");
  assert.equal(style.paddingLeft, "0px", "a declared tree body adds left padding around the tree");
  assert.equal(style.paddingBottom, "0px", "a declared tree body adds bottom padding around the tree");
  assert.equal(style.paddingRight, "0px", "a declared tree body adds right padding around the tree");
});

test("declared UI buttons do not keep the browser's native appearance", async (t) => {
  const { dom, body } = await draw(t, "button-appearance");
  const buttons = [...body.querySelectorAll("button")];
  assert.deepEqual(buttons.map((button) => button.className).sort(),
    ["declared-button", "declared-button", "declared-expand", "declared-label", "declared-label"].sort());
  for (const button of buttons) {
    const style = dom.window.getComputedStyle(button);
    assert.equal(style.appearance, "none", `${button.className} keeps native appearance`);
    assert.equal(style.padding, "0px", `${button.className} keeps browser padding`);
    assert.equal(style.borderTopWidth, "0px", `${button.className} keeps a browser border`);
    assert.equal(style.backgroundColor, "rgba(0, 0, 0, 0)", `${button.className} keeps a browser background`);
  }
});
