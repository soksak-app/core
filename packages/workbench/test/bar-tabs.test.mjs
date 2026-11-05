// The project and space tab strips draw again while a person presses a tab. These run the draw that index.html calls.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createBarTabs } from "../bar-tabs.js";

const SPACES = [{ id: "s1", title: "one" }, { id: "s2", title: "two" }];

/** The strips over a fixture of two projects, of which the first is shown with two spaces. */
function strips() {
  const { document } = new JSDOM(`<div id="projectBar"></div><main id="workarea"></main><div id="spaceBar"></div>`).window;
  globalThis.document = document;
  const state = {
    library: false,
    all: [{ id: "p1", title: "first", color: "#111", activeSpaceId: "s1", spaces: SPACES }, { id: "p2", title: "second", color: "#222", spaces: [] }],
  };
  const projects = {
    active: () => (state.library ? null : state.all[0]),
    all: () => state.all,
    inLibrary: () => state.library,
  };
  let redraws = 0;
  const projectBar = document.getElementById("projectBar");
  const spaceBar = document.getElementById("spaceBar");
  const workarea = document.getElementById("workarea");
  const tabs = createBarTabs({ projects, projectBar, spaceBar, workarea, bind: () => {}, run: async () => {}, keyboardOwed: () => {},
    redraw: () => { redraws += 1; }, changed: () => {} });
  const texts = (strip) => [...strip.children].map((child) => child.textContent);
  return { state, tabs, projectBar, spaceBar, workarea, texts, redraws: () => redraws };
}

test("a draw between a press and its release keeps the pressed project and space tabs", () => {
  const { tabs, projectBar, spaceBar } = strips();
  tabs.draw(false);
  const [project, space] = [projectBar.children[1], spaceBar.children[1]];
  tabs.draw(false);
  assert.equal(projectBar.children[1], project, "the draw replaced the pressed project tab");
  assert.equal(spaceBar.children[1], space, "the draw replaced the pressed space tab");
  assert.equal(project.isConnected && space.isConnected, true);
});

test("the shown project tab has the background of its project, and another project tab has none", () => {
  const { tabs, projectBar } = strips();
  tabs.draw(false);
  const [shown, other] = projectBar.children;
  assert.equal(shown.dataset.tinted, "true");
  assert.equal(shown.style.getPropertyValue("--project-color"), "#111");
  assert.equal(other.dataset.tinted, undefined);
  assert.equal(other.style.getPropertyValue("--project-color"), "");
});

test("the top strip holds the project tabs and the plus button, and the space strip the spaces of the shown project", () => {
  const { tabs, projectBar, spaceBar, workarea, texts } = strips();
  tabs.draw(false);
  assert.deepEqual(texts(projectBar), ["first✕", "second✕", "+"]);
  assert.deepEqual(texts(spaceBar), ["one✕", "two✕", "+"]);
  assert.equal(workarea.querySelector(".project-column"), null);
});

test("the left column takes the project tabs from the top strip and gives them back", () => {
  const { tabs, projectBar, workarea, texts } = strips();
  tabs.draw(false);
  tabs.draw(true);
  const column = workarea.querySelector(".project-column");
  assert.deepEqual(texts(column), ["first✕", "second✕", "+"]);
  assert.deepEqual(texts(projectBar), []);
  tabs.draw(false);
  assert.equal(workarea.querySelector(".project-column"), null);
  assert.deepEqual(texts(projectBar), ["first✕", "second✕", "+"]);
});

test("the library draws no tab, also with the left setting", () => {
  const { state, tabs, projectBar, spaceBar, workarea, texts } = strips();
  tabs.draw(false);
  state.library = true;
  tabs.draw(true);
  assert.deepEqual(texts(projectBar), []);
  assert.deepEqual(texts(spaceBar), []);
  assert.equal(workarea.querySelector(".project-column"), null);
});

test("a tab whose project or space changed is replaced and the other tabs stay", () => {
  const { state, tabs, projectBar, spaceBar } = strips();
  tabs.draw(false);
  const [first, second] = [spaceBar.children[0], spaceBar.children[1]];
  const project = projectBar.children[0];
  state.all[0] = { ...state.all[0], activeSpaceId: "s2" };
  tabs.draw(false);
  assert.equal(projectBar.children[0], project);
  assert.notEqual(spaceBar.children[0], first, "the tab that stopped being active kept its state");
  assert.equal(spaceBar.children[0].dataset.on, "false");
  assert.notEqual(spaceBar.children[1], second);
  assert.equal(spaceBar.children[1].dataset.on, "true");
});

test("the last space has no close control and a second space gives both one", () => {
  const { state, tabs, spaceBar } = strips();
  state.all[0] = { ...state.all[0], spaces: [SPACES[0]] };
  tabs.draw(false);
  assert.equal(spaceBar.querySelector(".bar-tab__x"), null);
  state.all[0] = { ...state.all[0], spaces: SPACES };
  tabs.draw(false);
  assert.equal(spaceBar.querySelectorAll(".bar-tab__x").length, 2);
});

test("a rename puts the field in the place of its tab and a cancel gives the tab back", () => {
  const { tabs, spaceBar, redraws } = strips();
  tabs.draw(false);
  tabs.renames.begin({ kind: "space", id: "s2" });
  assert.equal(redraws(), 1);
  tabs.draw(false);
  assert.equal(spaceBar.children[1].tagName, "INPUT");
  assert.equal(spaceBar.children[1].value, "two");
  assert.equal(spaceBar.children[0].tagName, "BUTTON");
  tabs.renames.cancel();
  tabs.draw(false);
  assert.equal(spaceBar.children[1].tagName, "BUTTON");
  assert.equal(tabs.renames.state(), null);
});
