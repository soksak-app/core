// While the window is key and no modal is open, the active surface of the card with the focus ring holds the keyboard
// (docs/spec/exposure.md#keyboard-focus). The workbench of the Wails and the Tauri hosts is this page, so this table judges both;
// each host holds its side of the call through its own contract test.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const pluginId = "fixture-keyboard";
const flush = () => new Promise((done) => setImmediate(done));

/** The page over a host that records the keyboard calls. The modules hold their state for the whole file. */
async function page() {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // The plane aligns itself to the device pixel grid of this scale on every draw (device-grid.js).
  globalThis.devicePixelRatio = dom.window.devicePixelRatio;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent ?? dom.window.MouseEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  const planeEl = document.getElementById("plane");
  Object.defineProperty(planeEl, "clientWidth", { value: 1200 });
  Object.defineProperty(planeEl, "clientHeight", { value: 800 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  const calls = [];
  const decisions = [];
  /* held: a promise that the next keyboard calls answer with, null to answer at once. */
  const focusAnswer = { held: null };
  // The surface of each decided surfaceFocus.
  const ends = [];
  const modal = { open: null, listeners: new Set() };
  const actualHost = await import("../host.js");
  mock.module("../host.js", { exports: {
    ...actualHost,
    report: (line) => assert.fail(`the page reported: ${line}`),
    surfaces: { ...actualHost.surfaces,
      focus: (surface, decided) => { calls.push(surface); if (decided) ends.push(surface); return focusAnswer.held ?? Promise.resolve(); } },
    modalState: () => modal.open,
    onModalState: (fn) => { modal.listeners.add(fn); return () => modal.listeners.delete(fn); },
  } });
  const actualLog = await import("../page-log.js");
  mock.module("../page-log.js", { exports: {
    ...actualLog,
    emitEvent: (level, event, fields) => { if (event === "workbench.keyboard.follow") decisions.push({ level, ...fields }); },
  } });
  mock.module("../surface-modules.js", { exports: {
    mountedSurface: () => null,
    surfaceForTab: (tab) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId: tab.id,
      pluginId: tab.plugin, declarations: {}, sidecars: [] }),
    mountSurface: () => Promise.resolve(),
    disposeSurface: () => Promise.resolve(), placePluginPlaceholder: () => {},
  } });
  mock.module("../environment.js", { exports: {
    environment: () => ({ workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } } }),
    pluginUnits: () => [{ id: pluginId, name: "Fixture", description: "fixture", surface: true, sections: [] }],
    refusedPlugins: () => new Set(),
  } });
  registerPlugin({
    id: pluginId, name: "Fixture", mark: "f", svg: "<path/>", ink: null, background: null, drop: null,
    surface: (surfaceId) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId, pluginId,
      declarations: {}, sidecars: [] }),
  });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  const keyboard = await import("../keyboard.js");
  registry.command("core.tab.select", ({ tab }) => plane.selectTab(tab));
  registry.command("core.card.focus", ({ card }) => plane.focusCard(card));

  let held = null;
  plane.onLayout((_made, draw) => { held = draw; });

  /** The surfaces of the drawn plane: the active tab of each card, and every tab, which the placement gives the host. */
  const shownSurfaces = () => plane.currentGrid().cards.map((card) => card.data.activeId);
  const heldSurfaces = () => plane.currentGrid().cards.flatMap((card) => card.data.tabs.map((tab) => tab.id));
  /** Draws what a path changed and answers the placement, as the commit of the page does. */
  const placed = async () => {
    await flush();
    plane.settle();
    held?.();
    await flush();
    keyboard.keyboardPlaced(shownSurfaces(), heldSurfaces());
    await flush();
  };
  const ringSurface = () => plane.currentGrid().card(plane.focused()).data.activeId;
  const openProject = () => {
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    return placed();
  };
  /** Sets the page to a plane of two cards with no open modal and forgets the calls that it took. */
  const reset = async () => {
    modal.open = null;
    await openProject();
    plane.splitCard(plane.focused(), "right", pluginId);
    await placed();
    calls.length = 0;
  };
  return { calls, decisions, ends, flush, focusAnswer, heldSurfaces, held: () => held, keyboard, modal, openProject, placed, plane,
    reset, ringSurface, shownSurfaces };
}

const b = await page();

/** The card of the two that does not have the ring. */
const otherCard = ({ plane }) => plane.currentGrid().cards.map(({ id }) => id).find((id) => id !== plane.focused());
const tabElement = (id) => document.querySelector(`.tab[data-tab-id="${id}"]`);
// A press of the page captures the pointer, which jsdom does not implement, as the press of a person does.
const press = (element, type) => {
  element.setPointerCapture ??= () => {};
  element.hasPointerCapture ??= () => true;
  element.releasePointerCapture ??= () => {};
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1 });
  element.dispatchEvent(event);
  return event;
};

const paths = {
  "opening a project": (page) => page.openProject(),
  "restoring a space": async (b) => {
    const kept = b.plane.capture();
    b.plane.clear();
    await b.flush();
    b.calls.length = 0;
    b.plane.adopt(kept, "spc-aaaaaa");
    await b.placed();
  },
  "a new tab": async (b) => {
    b.plane.addTabTo(b.plane.focused(), pluginId, null);
    await b.placed();
  },
  "a new tab of another card": async (b) => {
    b.plane.addTabTo(otherCard(b), pluginId, null);
    await b.placed();
  },
  "a split": async (b) => {
    b.plane.splitCard(b.plane.focused(), "bottom", pluginId);
    await b.placed();
  },
  "a press on a tab": async (b) => {
    const other = b.plane.currentGrid().card(otherCard(b)).data.activeId;
    const tab = tabElement(other);
    press(tab, "pointerdown");
    press(tab, "pointerup");
    await b.placed();
  },
  "core.tab.select": async (b) => {
    const other = b.plane.currentGrid().card(otherCard(b)).data.activeId;
    b.plane.selectTab(other);
    await b.placed();
  },
  "core.card.focus": async (b) => {
    b.plane.focusCard(otherCard(b));
    await b.placed();
  },
  "closing the active tab": async (b) => {
    const card = b.plane.focused();
    b.plane.addTabTo(card, pluginId, null);
    await b.placed();
    b.calls.length = 0;
    b.plane.closeTabById(b.plane.currentGrid().card(card).data.activeId);
    await b.placed();
  },
  "closing a card": async (b) => {
    const gone = b.plane.focused();
    b.plane.splitCard(gone, "bottom", pluginId);
    await b.placed();
    b.calls.length = 0;
    b.plane.closeCard(b.plane.focused());
    await b.placed();
  },
  "closing a modal": async (b) => {
    b.modal.open = { id: "pickerLayer" };
    for (const fn of b.modal.listeners) fn();
    await b.flush();
    b.calls.length = 0;
    b.modal.open = null;
    for (const fn of b.modal.listeners) fn();
    await b.flush();
  },
  "AppKit moving the keyboard to the workbench": async (b) => {
    b.keyboard.keyboardResponder({ owner: "workbench" });
    await b.flush();
  },
};

for (const [name, path] of Object.entries(paths)) {
  test(`the keyboard follows the ring: ${name}`, { timeout: 5000 }, async () => {
    await b.reset();
    await path(b);
    assert.ok(b.calls.length > 0, `the ring is on ${b.ringSurface()} and no keyboard call reached the host`);
    assert.equal(b.calls.at(-1), b.ringSurface(), "the keyboard and the ring disagree");
  });
}

test("a surface that no placement shows yet takes the keyboard when a placement shows it", { timeout: 5000 }, async () => {
  await b.reset();
  const tab = b.plane.addTabTo(b.plane.focused(), pluginId, null);
  await b.flush();
  assert.ok(!b.calls.includes(tab.tab ?? tab), "the keyboard went to a surface that no placement shows");
  await b.placed();
  assert.equal(b.calls.at(-1), b.ringSurface());
});

test("a press on a tab whose surface the host holds sends the call before the placement", { timeout: 5000 }, async () => {
  await b.reset();
  const card = b.plane.focused();
  b.plane.addTabTo(card, pluginId, null);
  await b.placed();
  const hidden = b.plane.currentGrid().card(card).data.tabs.map(({ id }) => id).find((id) => id !== b.ringSurface());
  b.calls.length = 0;
  const tab = tabElement(hidden);
  press(tab, "pointerdown");
  await b.flush();
  assert.deepEqual(b.calls, [hidden], "the keyboard call of the press waited for the placement");
  press(tab, "pointerup");
  await b.placed();
});

test("each decision of the keyboard is recorded with its cause", { timeout: 5000 }, async () => {
  await b.reset();
  const before = b.ringSurface();
  b.plane.addTabTo(b.plane.focused(), pluginId, null);
  await b.flush();
  const added = b.ringSurface();
  assert.deepEqual(b.decisions.at(-1), { level: "debug", cause: "ring", target: added, sent: before, owed: true, decided: false, decision: "wait" },
    "the new tab waits for the placement that holds it");
  await b.placed();
  assert.equal(b.decisions.at(-1).cause, "placed");
  assert.equal(b.decisions.at(-1).decision, "send");
  b.keyboard.keyboardResponder({ owner: "workbench" });
  await b.flush();
  assert.deepEqual(b.decisions.at(-1), { level: "debug", cause: "responder", target: added, sent: added, owed: true, decided: false, decision: "send" });
});

// Each release of a left press on the workbench asks for one decided call, which the page sends in the dispatch of the release, from
// what the press changed, on any element (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring).
const pressTargets = {
  "a hidden tab": (b) => tabElement(b.plane.currentGrid().card(b.plane.focused()).data.tabs.map(({ id }) => id).find((id) => id !== b.ringSurface())),
  "the active tab": (b) => tabElement(b.ringSurface()),
  "a card header": () => document.querySelector('[data-expose="core.card.header"]'),
  "a card": () => document.querySelector(".card"),
  "a divider": () => document.querySelector('[data-expose="core.divider"]'),
  "the plane": () => document.getElementById("plane"),
  "the chrome bar": () => document.querySelector('[data-expose="core.chrome.bar"]'),
  "the space bar": () => document.getElementById("spaceBar"),
  "the body": () => document.body,
};
for (const [name, element] of Object.entries(pressTargets)) {
  test(`a press on ${name} ends with one decided call`, { timeout: 5000 }, async () => {
    await b.reset();
    b.plane.addTabTo(b.plane.focused(), pluginId, null);
    await b.placed();
    const target = element(b);
    assert.ok(target, `the page has no ${name}`);
    b.ends.length = 0;
    press(target, "pointerdown");
    press(target, "pointerup");
    assert.deepEqual(b.ends, [b.ringSurface()], "the release did not send its decided call to the ring in its dispatch");
    await new Promise((done) => setTimeout(done, 10));
    await b.placed();
    assert.equal(b.ends.length, 1, `the decided calls of the press: ${JSON.stringify(b.ends)}`);
  });
}

test("a release while the ring is on a surface that the host does not hold decides for the workbench", { timeout: 5000 }, async () => {
  await b.reset();
  const before = b.ringSurface();
  b.plane.addTabTo(b.plane.focused(), pluginId, null);
  await b.flush();
  const added = b.ringSurface();
  b.ends.length = 0;
  b.calls.length = 0;
  press(document.body, "pointerdown");
  press(document.body, "pointerup");
  assert.deepEqual(b.ends, [null], "the release did not send one decided call for the workbench in its dispatch");
  assert.deepEqual(b.decisions.at(-1), { level: "debug", cause: "press", target: null, sent: before, owed: true, decided: true, decision: "send" });
  await b.placed();
  assert.equal(b.calls.at(-1), added, "the placement that gave the host the surface did not move the keyboard to it");
  assert.deepEqual(b.ends, [null], "the placement sent a second decided call");
});

test("a release while a keyboard call has no answer sends its decided call", { timeout: 5000 }, async () => {
  await b.reset();
  const release = holdFocus();
  b.plane.focusCard(otherCard(b));
  await b.flush();
  b.ends.length = 0;
  press(document.body, "pointerdown");
  press(document.body, "pointerup");
  assert.deepEqual(b.ends, [b.ringSurface()], "the decided call waited for the answer of the earlier keyboard call");
  release();
  await b.placed();
});

test("a release while a modal is open decides for the ring and the modal keeps the keyboard", { timeout: 5000 }, async () => {
  await b.reset();
  b.modal.open = { id: "pickerLayer" };
  for (const fn of b.modal.listeners) fn();
  await b.flush();
  b.ends.length = 0;
  b.calls.length = 0;
  press(document.body, "pointerdown");
  press(document.body, "pointerup");
  assert.deepEqual(b.ends, [b.ringSurface()], "the release in a modal did not send one decided call for the ring");
  assert.equal(b.decisions.at(-1).decision, "modal");
  b.modal.open = null;
  for (const fn of b.modal.listeners) fn();
  await b.flush();
  assert.equal(b.calls.at(-1), b.ringSurface(), "the close of the modal did not give the keyboard back to the ring");
});

test("the page never holds the input of the window", () => {
  const folder = new URL("../", import.meta.url);
  const sources = readdirSync(folder).filter((name) => name.endsWith(".js") || name.endsWith(".html"));
  const holds = sources.filter((file) => /keyboardHold|keyboardDecided/.test(readFileSync(new URL(file, folder), "utf8")));
  assert.deepEqual(holds, [], "a source sends a hold of the input or its end");
});

test("a modal keeps the keyboard until it closes", { timeout: 5000 }, async () => {
  await b.reset();
  b.modal.open = { id: "pickerLayer" };
  for (const fn of b.modal.listeners) fn();
  b.calls.length = 0;
  b.plane.focusCard(otherCard(b));
  await b.placed();
  assert.deepEqual(b.calls, [], "the workbench moved the keyboard out of an open modal");
  b.modal.open = null;
  for (const fn of b.modal.listeners) fn();
  await b.flush();
  assert.equal(b.calls.at(-1), b.ringSurface());
});

test("the library keeps the keyboard with the workbench", { timeout: 5000 }, async () => {
  await b.reset();
  b.plane.clear();
  await b.flush();
  assert.deepEqual(b.calls, [null]);
});

test("a card without a surface leaves the keyboard with the workbench", { timeout: 5000 }, async () => {
  await b.reset();
  const missing = "fixture-not-installed";
  const card = b.plane.currentGrid().card(b.plane.focused());
  const orphan = { ...card.data.tabs[0], id: "tab-orphan", plugin: missing };
  b.plane.currentGrid().setData(card.id, { tabs: [...card.data.tabs, orphan], activeId: orphan.id });
  b.plane.focusCard(card.id);
  await b.flush();
  assert.equal(b.calls.at(-1), null);
});

test("an editable element of the workbench holds the keyboard while it has the focus", { timeout: 5000 }, async () => {
  await b.reset();
  const input = document.createElement("input");
  document.body.appendChild(input);
  b.calls.length = 0;
  input.focus();
  await b.flush();
  assert.deepEqual(b.calls, [null], "the rename field did not take the keyboard");
  b.keyboard.keyboardResponder({ owner: "workbench" });
  await b.flush();
  assert.deepEqual(b.calls, [null], "the workbench took the keyboard from its own field");
  input.blur();
  input.remove();
  await b.flush();
  assert.equal(b.calls.at(-1), b.ringSurface());
});

test("a press on a tab leaves no element focus, and the Tab key keeps its stop", { timeout: 5000 }, async () => {
  await b.reset();
  const tab = tabElement(b.ringSurface());
  assert.ok(press(tab, "mousedown").defaultPrevented, "a press would move the DOM focus to the tab");
  // The Tab key moves the focus without a press, and a first responder in the workbench does not take that stop away.
  tab.tabIndex = 0;
  tab.focus();
  await b.flush();
  b.calls.length = 0;
  b.keyboard.keyboardResponder({ owner: "workbench" });
  await b.flush();
  assert.deepEqual(b.calls, []);
  assert.equal(document.activeElement, tab);
});

test("the ring moves in one function of the plane", () => {
  const folder = new URL("../", import.meta.url);
  const moves = [];
  for (const file of readdirSync(folder).filter((name) => name.endsWith(".js"))) {
    readFileSync(new URL(file, folder), "utf8").split("\n").forEach((line, index) => {
      if (/\bfocusedId\s*=[^=]/.test(line)) moves.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.equal(moves.length, 1, `direct moves of the ring:\n${moves.join("\n")}`);
  assert.match(moves[0], /^plane\.js:\d+: focusedId = id;$/);
});

test("the page answers each placement and each responder move to the keyboard", () => {
  const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(page, /if \(record\.drawn\) await keyboardPlaced\(/);
  // The field of a rename leaves the document in this draw, and a removal does not always report the lost focus.
  assert.match(page, /createBarTabs\(\{[^}]*keyboardOwed/);
  const barTabs = readFileSync(new URL("../bar-tabs.js", import.meta.url), "utf8");
  assert.equal(barTabs.match(/redraw\(\);\n\s+keyboardOwed\(\);/g)?.length, 2);
  const exposure = readFileSync(new URL("../core-exposure.js", import.meta.url), "utf8");
  assert.match(exposure, /keyboardResponder\(event\);/);
});

/** Holds the answer of the keyboard calls until the returned function runs. */
function holdFocus() {
  let release;
  b.focusAnswer.held = new Promise((done) => { release = done; });
  return () => { b.focusAnswer.held = null; release(); };
}

/** Answers a drawn placement and tells whether the placement ended before the host answered the keyboard call. */
async function placementEnd() {
  await b.flush();
  b.plane.settle();
  b.held()?.();
  await b.flush();
  let ended = false;
  const end = Promise.resolve(b.keyboard.keyboardPlaced(b.shownSurfaces(), b.heldSurfaces())).then(() => { ended = true; });
  await b.flush();
  return { end, ended: () => ended };
}

test("a placement ends when the host answered the keyboard call to the new tab", { timeout: 5000 }, async () => {
  await b.reset();
  const release = holdFocus();
  b.plane.addTabTo(b.plane.focused(), pluginId, null);
  const { end, ended } = await placementEnd();
  assert.equal(b.calls.at(-1), b.ringSurface(), "the placement sent no keyboard call to the new tab");
  assert.equal(ended(), false, "the placement ended before the host answered the keyboard call");
  release();
  await end;
});

test("a placement ends when the host answered the keyboard call that went before it", { timeout: 5000 }, async () => {
  await b.reset();
  const release = holdFocus();
  b.plane.focusCard(otherCard(b));
  await b.flush();
  assert.equal(b.calls.at(-1), b.ringSurface(), "the move of the ring sent no keyboard call ahead of the placement");
  const { end, ended } = await placementEnd();
  assert.equal(ended(), false, "the placement ended before the host answered the keyboard call");
  release();
  await end;
});
