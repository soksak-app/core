// The edge button of a hidden side that has a choice shows the + <side> button where the window sidebar would stand; its command is the
// side switch with the value true and the scope of the side (docs/spec/external-sidebars.md#sidebar-head-and-edge).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import exposureFile from "../exposure.json" with { type: "json" };

const dom = new JSDOM('<!doctype html><body><div id="edges"></div></body>', { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { installExposure } = await import("../exposure.js");
installExposure(exposureFile);
const { createSidebarEdges } = await import("../sidebar-edges.js");

// The applied value of a side and the scope it comes from, as the settings module reports them for the common scope.
const appliedPatch = (side, value) => ({ patch: { [side]: value }, scope: "common" });

test("each side has an edge button named + <side> that changes the side to shown with its scope", () => {
  const edges = createSidebarEdges(document.getElementById("edges"), { appliedPatch, links: () => [], value: () => false });
  edges.draw(false);
  const labels = [...document.querySelectorAll(".sidebar-edge")].map((edge) => [edge.dataset.side, edge.querySelector("button").textContent]);
  assert.deepEqual(labels, [["left", "+ 왼쪽"], ["right", "+ 오른쪽"], ["top", "+ 위"], ["bottom", "+ 아래"]]);
  const button = document.querySelector('.sidebar-edge[data-side="top"] button');
  assert.equal(button.dataset.expose, "core.sidebar.edge");
  assert.equal(button.dataset.command, "core.settings.change");
});

test("an edge shows only for a hidden side that has a choice, and never on the project home or in the settings tab", () => {
  const links = [{ place: "left", plugin: null, set: "fixture-set" }, { place: "window-top", plugin: "fixture", set: "fixture-set" }];
  const visible = { left: false, right: false, top: false, bottom: false };
  const edges = createSidebarEdges(document.getElementById("edges"), { appliedPatch, links: () => links, value: (side) => visible[side] });
  const shown = () => [...document.querySelectorAll(".sidebar-edge")].filter((edge) => !edge.hidden).map((edge) => edge.dataset.side);
  edges.draw(false);
  assert.deepEqual(shown(), ["left", "top"], "a hidden side with a general or a plugin choice shows its edge");
  visible.left = true;
  edges.draw(false);
  assert.deepEqual(shown(), ["top"], "a shown side has no edge");
  edges.draw(true);
  assert.deepEqual(shown(), [], "no edge while the project home or the settings tab is in front");
});
