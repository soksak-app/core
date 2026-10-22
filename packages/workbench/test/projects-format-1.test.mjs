// A format-1 projects.json whose layout tabs carry the optional origin member (docs/spec/projects.md#tab-origin, F238-a-11). The fixture is
// the file as the reader of the host hands it to the page. A view tab with origin is restored with it; a view tab without origin is
// refused per tab with the missing-origin text; the layout still passes the check that opens a space, so opening the space succeeds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

globalThis.document = new JSDOM("<body></body>").window.document;
const viewManifest = {
  id: "probe-view", name: "View", description: "검사용 view.", mark: "V", icon: "<path d='M0 0h1v1H0z'/>",
  surface: { composition: { kind: "view", page: "ui/view.html" } },
};
const plainManifest = {
  id: "probe-plain", name: "Plain", description: "검사용.", mark: "P", icon: "<path d='M0 0h1v1H0z'/>",
  surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
};
const environmentFile = {
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
    { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "probe-plain", title: "p" }] },
  ] } },
  sidebars: { sets: [], links: [] },
};
const { installEnvironment } = await import("../environment.js");
installEnvironment(environmentFile, { plugins: [
  { id: "probe-view", package: "@fixture/probe-view", version: "0.0.1", manifest: viewManifest },
  { id: "probe-plain", package: "@fixture/probe-plain", version: "0.0.1", manifest: plainManifest },
] });
const { checkStoredLayout, recordStoredOrigins } = await import("../stored-layout.js");
const { tabOrigin, viewRefusal, tabError } = await import("../tab-reports.js");

const file = JSON.parse(readFileSync(new URL("./fixtures/projects-format-1.json", import.meta.url), "utf8"));
const isView = (plugin) => plugin === "probe-view";
const spaceOf = (projectId) => file.projects.find((project) => project.id === projectId).spaces[0];

test("the format-1 fixture is the form 1 file with origin members on view tabs", () => {
  assert.equal(file.format, 1);
  const origin = file.projects[0].spaces[0].layout.state.cards[0].data.tabs[0];
  assert.deepEqual(origin.origin, { directory: "/work/origin" });
});

test("a format-1 layout with a view origin opens and restores the origin of its view tab", () => {
  const layout = spaceOf("prj-origin").layout;
  assert.doesNotThrow(() => checkStoredLayout(layout));
  const refusals = recordStoredOrigins({ state: layout.state }, isView);
  assert.deepEqual(refusals, [], "a valid view origin was refused");
  assert.deepEqual(tabOrigin("tab-view"), { directory: "/work/origin" });
  assert.equal(viewRefusal("tab-view"), null);
  assert.equal(tabError("tab-view"), null);
});

test("a format-1 layout without a view origin opens, and its view tab is refused with the missing-origin text", () => {
  const layout = spaceOf("prj-legacy").layout;
  assert.doesNotThrow(() => checkStoredLayout(layout));
  const refusals = recordStoredOrigins({ state: layout.state }, isView);
  const text = 'surface "tab-legacy": view start origin is missing';
  assert.deepEqual(refusals, [{ tabId: "tab-legacy", text }], "the view tab without origin was not refused per tab");
  assert.equal(viewRefusal("tab-legacy"), text);
  assert.equal(tabError("tab-legacy"), text);
});
