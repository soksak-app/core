// The shared layout cases of the stored spaces and their tabs, of the fold stage of a card head, of the tabs of a card and of its sidebars
// (docs/spec/cases/layout). The Go layout model of
// packages/workbench-mygo runs the same files, so a case is one statement of the stored format that both implementations meet.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => JSON.parse(readFileSync(new URL(`../../../docs/spec/cases/layout/${name}`, import.meta.url), "utf8"));

/** Runs a call and checks its result: the value of `returns`, the message of `throws`, or no value. */
function check(run, step, where) {
  if (Object.hasOwn(step, "throws")) {
    assert.throws(run, (error) => error.message === step.throws, `${where}: does not throw ${step.throws}`);
    return;
  }
  const result = run();
  if (Object.hasOwn(step, "returns")) assert.deepEqual(result, step.returns, where);
  else assert.equal(result, undefined, `${where}: returns ${JSON.stringify(result)}`);
}

/** A plugin of the cases: a valid manifest that declares a view surface, or only a section. */
const manifestOf = ({ id, surface }) => ({
  id, name: id, description: "검사용.", mark: "P", icon: "<path d='M0 0h1v1H0z'/>",
  ...(surface ? { surface: { composition: { kind: "view", page: "ui/page.html" } } }
    : { sections: [{ id: `${id}.list`, name: "List", composition: { kind: "view", page: "ui/list.html" }, height: "fill" }] }),
});

const stored = read("stored.json");
const { installEnvironment } = await import("../environment.js");
const first = stored.plugins.find((plugin) => plugin.surface);
const installErrors = installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
    { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: first.id, title: "t" }] },
  ] } },
  sidebars: { sets: [], links: [] },
}, { plugins: stored.plugins.map((plugin) => ({ id: plugin.id, package: `@fixture/${plugin.id}`, version: "0.0.1", manifest: manifestOf(plugin) })) });
assert.deepEqual(installErrors, [], "the plugins of the cases are not loaded");
const { checkStoredLayout } = await import("../stored-layout.js");
const { restoreWindowSidebars } = await import("../window-sidebars.js");
const spaces = await import("../spaces.js");
const { fitHead } = await import("../head-fit.js");
const cardData = await import("../card-data.js");
const cardSidebars = await import("../card-sidebars.js");

const CHECKS = {
  storedLayout: (kase) => checkStoredLayout(kase.layout),
  windowSidebars: (kase) => restoreWindowSidebars(kase.records),
};

for (const kase of stored.cases) {
  test(`stored: ${kase.name}`, () => {
    assert.ok(CHECKS[kase.check], `no check ${kase.check}`);
    check(() => CHECKS[kase.check](kase), kase, kase.check);
  });
}

for (const kase of read("spaces.json").cases) {
  test(`spaces: ${kase.name}`, () => {
    const project = structuredClone(kase.project);
    kase.steps.forEach((step, i) => check(() => (step.call === "project" ? structuredClone(project)
      : spaces[step.call](project, ...(step.args ?? []))), step, `step ${i + 1} ${step.call}`));
  });
}

for (const kase of read("head.json").cases) {
  test(`head: ${kase.name}`, () => check(() => fitHead(kase.head), kase, "fitHead"));
}

const tabs = read("tabs.json");
for (const kase of tabs.cases) {
  test(`tabs: ${kase.name}`, () => {
    const card = structuredClone(kase.card);
    kase.steps.forEach((step, i) => check(() => (step.call === "card" ? structuredClone(card.data)
      : cardData[step.call](card, ...(step.args ?? []))), step, `step ${i + 1} ${step.call}`));
  });
}
for (const kase of tabs.names) {
  test(`tab name: ${kase.name}`, () => check(() => cardData.tabName(kase.tab, kase.reported, kase.modified), kase, "tabName"));
}

const sidebars = read("sidebars.json");
for (const kase of sidebars.cases) {
  test(`sidebars: ${kase.name}`, () => {
    const card = structuredClone(kase.card);
    const call = (step) => {
      if (step.call === "card") return structuredClone(card.data);
      const args = step.args;
      // setSidebar and resolveSidebarSet take the sets of the case after the side, the first two arguments of a step.
      if (step.call === "setSidebar") return cardSidebars.setSidebar(card, args[0], args[1], kase.sets);
      if (step.call === "resolveSidebarSet") return cardSidebars.resolveSidebarSet(card, args[0], kase.sets, args[1], args[2]);
      return cardSidebars[step.call](card, ...args);
    };
    kase.steps.forEach((step, i) => check(() => call(step), step, `step ${i + 1} ${step.call}`));
  });
}
for (const kase of sidebars.present) {
  test(`sidebar presentation: ${kase.name}`, () =>
    check(() => cardSidebars.presentSidebars(kase.requested, kase.rect, kase.metrics, kase.prefer), kase, "presentSidebars"));
}
for (const kase of sidebars.grid) {
  test(`sidebar grid: ${kase.name}`, () => check(() => cardSidebars.deviceGridSize(kase.size, kase.ratio), kase, "deviceGridSize"));
}
