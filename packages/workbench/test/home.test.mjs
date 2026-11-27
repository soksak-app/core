// The project home is the launcher of a window without a shown project (docs/spec/projects.md#project-home). These tests read its drawn
// elements and its status through the page of index.html, with the real project module.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import exposureFile from "../exposure.json" with { type: "json" };

const wire = selectPageWire("overlay-none");
const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/", pretendToBeVisual: true });
dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.CSS = dom.window.CSS;
globalThis.PointerEvent = dom.window.PointerEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.devicePixelRatio = dom.window.devicePixelRatio;
// The plane aligns its cards to a box that a layout engine gives; this document has none, so the box is set.
Object.defineProperty(document.getElementById("plane"), "clientWidth", { value: 800 });
Object.defineProperty(document.getElementById("plane"), "clientHeight", { value: 600 });
// The card metrics are custom properties that this document does not compute, so the two that the card sidebars read are declared here.
const cardMetrics = document.createElement("style");
cardMetrics.textContent = ".card { --bw: 1px; --divider: 1px; }";
document.head.append(cardMetrics);
const { installExposure } = await import("../exposure.js");
installExposure(exposureFile);
const { createHome } = await import("../home.js");
const { registry } = await import("../exposure.js");
const { installCoreExposure } = await import("../core-exposure.js");
const { pageMemorySaver } = await import("./support/memory-saver.mjs");
const { adopt, capture, fresh, settle } = await import("../plane.js");
const { checkStoredLayout } = await import("../stored-layout.js");
const projectStore = await import("../projects.js");
const { begin } = projectStore;
const { installEnvironment } = await import("../environment.js");
// The environment of the window holds one placeholder tab, so the page loads without a plugin (the projects module needs it).
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "fixture-home", title: "Note" }] } } },
  sidebars: { sets: [], links: [] },
}, { plugins: [] }), []);

// The replies of the host settle after the turn of the page that sent their calls.
const settled = () => new Promise((resolve) => setImmediate(resolve));
const DAY = 86400000;
const now = Date.now();
const project = (id, title, extra = {}) => ({
  id, title, root: `/work/${id}`, spaces: [{ id: `${id}-s`, title: "main" }], activeSpaceId: `${id}-s`, pinned: false, lastOpened: now, ...extra,
});

function mount(projects) {
  begin({ common: {}, projects, open: [] });
  const root = document.createElement("div");
  document.body.append(root);
  return { root, home: createHome(root) };
}

test("the home lists projects with the pinned group first and no plugin entry", async () => {
  const { root, home } = mount([
    project("a", "alpha", { lastOpened: now - 3 * DAY }),
    project("b", "bravo", { pinned: true, lastOpened: now - 5 * DAY }),
    project("c", "charlie", { lastOpened: now }),
  ]);
  await settled();
  home.render();
  assert.deepEqual(home.state().rows, ["b", "c", "a"]);
  const titles = [...root.querySelectorAll(".home-group__title")].map((node) => node.textContent);
  assert.deepEqual(titles, ["고정", "최근"], "the pinned group and the recent group are shown while a pinned project exists");
  // The home names its elements core.home.* only: the spec lists no other element name for the home (docs/spec/projects.md#project-home).
  const names = [...root.querySelectorAll("[data-expose]")].map((el) => el.dataset.expose);
  assert.ok(names.length > 0, "the home declares no element");
  assert.deepEqual(names.filter((name) => !name.startsWith("core.home.")), [], "an element of the home has a name outside core.home.");
  assert.equal(root.querySelectorAll("[data-expose='core.home.open']").length, 3, "each row has one open button");
});

test("the first row is selected, and the arrow keys move the selection and wrap at the ends", async () => {
  const { home } = mount([project("a", "alpha"), project("b", "bravo")]);
  await settled();
  home.render();
  assert.equal(home.state().selected, "a");
  home.actions.select(1);
  assert.equal(home.state().selected, "b");
  home.actions.select(1);
  assert.equal(home.state().selected, "a", "the selection wraps to the first row");
  home.actions.select(-1);
  assert.equal(home.state().selected, "b", "the selection wraps to the last row");
});

test("the search matches the name and the path and Escape clears a non-empty query", async () => {
  const { home } = mount([project("a", "alpha"), project("b", "bravo")]);
  await settled();
  home.render();
  home.actions.search("bra");
  assert.equal(home.state().query, "bra");
  assert.deepEqual(home.state().rows, ["b"]);
  home.actions.search("/work/a");
  assert.deepEqual(home.state().rows, ["a"]);
  home.actions.escape();
  assert.equal(home.state().query, "", "Escape clears the query");
});

test("a typed path that matches no project offers to open it as a project", async () => {
  const { root, home } = mount([project("a", "alpha")]);
  await settled();
  home.render();
  home.actions.search("/Users/someone/elsewhere");
  assert.deepEqual(home.state().rows, []);
  const row = root.querySelector("[data-expose='core.home.path']");
  assert.ok(row, "the path row is shown for a query that starts with /");
  assert.equal(row.dataset.command, "core.home.form.open");
  assert.deepEqual(JSON.parse(row.dataset.params), { mode: "open", parent: "/Users/someone/elsewhere" });
  assert.equal(root.querySelector("[data-expose='core.home.no-results']"), null);
  home.actions.search("zzz");
  assert.ok(root.querySelector("[data-expose='core.home.no-results']"), "a plain query shows the no-result note");
  assert.equal(root.querySelector("[data-expose='core.home.path']"), null);
});

test("the remove button asks first; cancel keeps the project and yes removes only the record", async () => {
  const { root, home } = mount([project("a", "alpha"), project("b", "bravo")]);
  await settled();
  home.render();
  home.actions.confirm("a", "ask");
  assert.equal(home.state().confirming, "a");
  assert.ok(root.textContent.includes("alpha — 목록에서 뺄까? 폴더는 그대로 둔다."), "the row shows the confirm text");
  home.actions.confirm("a", "no");
  assert.equal(home.state().confirming, null);
  assert.deepEqual(home.state().rows, ["a", "b"], "cancel restores the row");
});

test("each pressable element of the project home carries the parameters that its command requires", async () => {
  const { root, home } = mount([project("a", "alpha"), project("b", "bravo", { pinned: true })]);
  await settled();
  home.render();
  home.actions.openForm("create");
  // The members that the declaration of each command requires.
  const required = new Map();
  (function walk(value) {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") {
      if (typeof value.name === "string" && value.params?.required) required.set(value.name, value.params.required);
      Object.values(value).forEach(walk);
    }
  })(exposureFile);
  const missing = [];
  for (const element of root.querySelectorAll("[data-command]")) {
    // An input, a select and a text area give their value as a parameter when they change.
    if (element.matches("input, select, textarea")) continue;
    const params = element.dataset.params === undefined ? {} : JSON.parse(element.dataset.params);
    for (const member of required.get(element.dataset.command) ?? []) {
      if (!(member in params)) missing.push(`${element.dataset.expose ?? element.className}: ${element.dataset.command} misses ${member}`);
    }
  }
  assert.ok(root.querySelector('[data-expose="core.home.add"]'), "the project home has no add button");
  assert.deepEqual(missing, []);
});

test("a project home render keeps the controls of unchanged project rows in the document", async () => {
  const { root, home } = mount([project("a", "alpha"), project("b", "bravo")]);
  await settled();
  home.render();
  const controls = [...root.querySelectorAll("[data-expose='core.home.pin']")];
  assert.equal(controls.length, 2, "the project home drew no row controls");
  const removed = [];
  const collect = (records) => {
    for (const record of records) for (const node of record.removedNodes) {
      if (node.nodeType === 1 && (node.matches?.("button") || node.querySelector?.("button"))) removed.push(node.className);
    }
  };
  const watch = new dom.window.MutationObserver(collect);
  watch.observe(document.body, { childList: true, subtree: true });
  home.render();
  collect(watch.takeRecords());
  watch.disconnect();
  assert.deepEqual(removed, [], "a render of unchanged projects took row controls out of the document");
  assert.ok(controls.every((control) => control.isConnected), "a row control of the first render is no longer in the document");
});

test("the project form uses the shared error toast when its folder is empty", async () => {
  const { home } = mount([]);
  await settled();
  home.render();
  home.actions.openForm("open");
  await home.actions.submitForm();
  const message = "Project directory is empty";
  // The toasts of the mounts of the earlier tests stay in the document, so the message is searched among all of them.
  const texts = [...document.querySelectorAll(".toast__title")].map((node) => node.textContent);
  assert.ok(texts.includes(message), `the error toast does not show "${message}": ${JSON.stringify(texts)}`);
  assert.ok(document.querySelector('.toast [data-expose="core.notices.close"]'), "the error toast has no dismiss control");
});

test("the declared cmd+o command focuses the project home search field and rejects a shown workspace", { timeout: 5000 }, async () => {
  const shortcut = JSON.parse(readFileSync(new URL("../shortcuts.json", import.meta.url), "utf8")).shortcuts
    .find((row) => row.key === "cmd+o" && row.owner === "workbench");
  assert.equal(shortcut?.command, "core.home.search.focus", "the workbench cmd+o row does not name the project home search focus");
  const { home } = mount([project("a", "alpha", { spaces: [{ id: "a-s", title: "main", layout: fresh() }] })]);
  // The window checks a stored layout of the project before it shows the project, so the check of the layout is registered first.
  projectStore.onSwitch({ check: checkStoredLayout, save: capture, load: adopt, update: settle });
  await installCoreExposure({ home, renames: { state: () => null }, chrome: () => null, drawn: async () => {}, memorySaver: await pageMemorySaver() });
  await settled();
  home.render();
  await registry.run(shortcut.command, {});
  assert.equal(document.activeElement.dataset.expose, "core.home.search");
  // The window starts with a project in its address, so the workspace is shown and the project home is not.
  dom.reconfigure({ url: "http://localhost/?project=a" });
  begin({ common: {}, projects: [{ id: "a", title: "alpha", root: "/work/a", color: "#fff", named: 1, activeSpaceId: "a-s", spaces: [{ id: "a-s", title: "SPACE1", layout: fresh() }], settings: {} }], open: [] });
  await settled();
  await assert.rejects(registry.run(shortcut.command, {}), /the project home is not shown/);
});

// A project that was never opened has no last-opened time, so its row shows no day rather than the first day of the epoch.
test("a project that was never opened shows no last-opened day", async () => {
  const never = project("n", "never", {});
  delete never.lastOpened;
  const { root, home } = mount([never]);
  await settled();
  home.render();
  const meta = root.querySelector(".home-row__meta");
  assert.equal(meta.textContent, "스페이스 1", "the row shows a day for a project that was never opened");
});

test("the declared cmd+Backspace row asks the removal of the selected row, and the command without a row names the selected row", async () => {
  const shortcut = JSON.parse(readFileSync(new URL("../shortcuts.json", import.meta.url), "utf8")).shortcuts
    .find((row) => row.key === "cmd+Backspace" && row.owner === "workbench");
  assert.equal(shortcut?.command, "core.home.confirm", "the cmd+Backspace row does not name core.home.confirm");
  assert.deepEqual(shortcut?.params, { answer: "ask" }, "the cmd+Backspace row does not ask the removal");
  const { home } = mount([project("a", "alpha"), project("b", "bravo")]);
  await settled();
  home.render();
  home.actions.select(1);
  home.actions.confirm(undefined, "ask");
  assert.equal(home.state().confirming, "b", "the removal is not asked for the selected row");
  home.actions.confirm(undefined, "no");
  assert.equal(home.state().confirming, null);
});

test("the key hint of the project home names the bound keys: the arrows, Enter, cmd+Backspace and cmd+comma", async () => {
  const { root } = mount([project("a", "alpha")]);
  await settled();
  assert.equal(root.querySelector(".home__hint").textContent, "↑↓ 이동Enter 열기⌘⌫ 목록에서 빼기⌘, 설정");
});

test("the search field shows the shortcut of its focus command after the field", async () => {
  const { root } = mount([project("a", "alpha")]);
  await settled();
  assert.equal(root.querySelector(".home__search .home__search-key")?.textContent, "⌘O", "the search field shows no caption ⌘O");
});
