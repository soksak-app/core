// While the window is key and no modal is open, the active surface of the card with the focus ring holds the keyboard
// (docs/spec/exposure.md#keyboard-focus). The workbench of the Wails and the Tauri hosts is this page, so this table judges both;
// each host holds its side of the call through its own contract test.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const pluginId = "fixture-keyboard";
// The host calls of the page are answered by the case of this test; it is selected before host.js is imported, because the page reads the host when it is imported.
const wire = selectPageWire("keyboard-follow-ring");

/** The page over the host of the case. The modules hold their state for the whole file. */
async function page() {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/", pretendToBeVisual: true });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // JSDOM has no adopted style sheets, which the page reads when it draws a native modal; the document adopts none.
  document.adoptedStyleSheets = [];
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

  // The keyboard calls of the page: each surfaceFocus call of the host, from the mark that forget sets.
  const marks = { calls: 0, ends: 0, decisions: 0 };
  const focusCalls = (from, decidedOnly) => wire.calls.slice(from)
    .filter(({ name, payload }) => name === "surfaceFocus" && (!decidedOnly || payload.decided === true))
    .map(({ payload }) => payload.surface);
  // The modal of the page: a native menu, which the host holds while it is shown.
  const menu = document.createElement("div");
  menu.id = "keyboardMenu";
  menu.setAttribute("aria-label", "Menu");
  menu.dataset.nativeModal = "menu";
  menu.setAttribute("style", "border-top-color: rgb(7, 8, 9); background-color: rgb(10, 11, 12); border-top-left-radius: 4px");
  document.body.appendChild(menu);
  // The decisions of the keyboard are events of the class input at the level debug, which the page stores while its log policy says so: a
  // test that reads them puts the policy in force for its length.
  const policy = (input) => ({ lifecycle: "error", input, call: "error", io: "error", frame: "error" });
  const host = await import("../host.js");
  const { flushEvents } = await import("../page-log.js");
  const { logGate } = await import("../log-gate.js");
  // The environment of the page: the plugin with its tab in the card. The surfaces of a page without a host are placeholders.
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: {
      xs: [0, 1], ys: [0, 1],
      cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: pluginId, title: "main" }] }],
    } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: pluginId, package: "@fixture/keyboard", version: "0.0.1", manifest: {
    id: pluginId, name: "Fixture", description: "fixture", mark: "f", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" } },
  } }] }), [], "the fixture environment refused a plugin");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const plane = await import("../plane.js");
  const keyboard = await import("../keyboard.js");
  registry.command("core.tab.select", ({ tab }) => plane.selectTab(tab));
  registry.command("core.card.focus", ({ card }) => plane.focusCard(card));

  let held = null;
  // Waits until the follows of the keyboard ended and the ordered calls that they queued were sent.
  const idle = async () => {
    await keyboard.idle();
    await new Promise(setImmediate);
  };
  plane.onLayout((_made, draw) => { held = draw; });

  /** The surfaces of the drawn plane: the active tab of each card, and every tab, which the placement gives the host. */
  const shownSurfaces = () => plane.currentGrid().cards.map((card) => card.data.activeId);
  const heldSurfaces = () => plane.currentGrid().cards.flatMap((card) => card.data.tabs.map((tab) => tab.id));
  /** Draws what a path changed and answers the placement, as the commit of the page does. */
  const placed = async () => {
    await idle();
    plane.settle();
    held?.();
    await idle();
    await keyboard.keyboardPlaced(shownSurfaces(), heldSurfaces());
  };
  const ringSurface = () => plane.currentGrid().card(plane.focused()).data.activeId;
  const openProject = () => {
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    return placed();
  };
  /** Sets the page to a plane of two cards with no open modal and forgets the calls that it took. */
  const reset = async () => {
    host.overlay.hide();
    await openProject();
    plane.splitCard(plane.focused(), "right", pluginId);
    await placed();
    marks.calls = wire.calls.length;
  };
  /** Stores the decisions of the keyboard until the test ends. */
  const watchDecisions = (t) => {
    logGate.set(policy("debug"));
    marks.decisions = wire.calls.length;
    t.after(() => { logGate.set(policy("error")); });
  };
  /** The decisions of the keyboard that the page relayed since watchDecisions, the last one included. */
  const decisions = async () => {
    await flushEvents();
    return wire.calls.slice(marks.decisions)
      .filter(({ name, payload }) => name === "log" && payload.action === "batch")
      .flatMap(({ payload }) => payload.events)
      .filter(({ event }) => event === "workbench.keyboard.follow")
      .map(({ level, fields }) => ({ level, ...fields }));
  };
  return { flushEvents, watchDecisions, decisions, calls: () => focusCalls(marks.calls, false), forgetCalls: () => { marks.calls = wire.calls.length; },
    ends: () => focusCalls(marks.ends, true), forgetEnds: () => { marks.ends = wire.calls.length; },
    idle, heldSurfaces, held: () => held, keyboard, menu, openProject, overlay: host.overlay, placed, plane,
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
    await b.idle();
    b.forgetCalls();
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
    b.forgetCalls();
    b.plane.closeTabById(b.plane.currentGrid().card(card).data.activeId);
    await b.placed();
  },
  "closing a card": async (b) => {
    const gone = b.plane.focused();
    b.plane.splitCard(gone, "bottom", pluginId);
    await b.placed();
    b.forgetCalls();
    b.plane.closeCard(b.plane.focused());
    await b.placed();
  },
  "closing a modal": async (b) => {
    b.overlay.show(b.menu, { x: 0, y: 0, w: 10, h: 10 }, () => {});
    await b.idle();
    b.forgetCalls();
    b.overlay.hide(b.menu);
    await b.idle();
  },
  "AppKit moving the keyboard to the workbench": async (b) => {
    b.keyboard.keyboardResponder({ owner: "workbench" });
    await b.idle();
  },
};

for (const [name, path] of Object.entries(paths)) {
  test(`the keyboard follows the ring: ${name}`, { timeout: 5000 }, async () => {
    await b.reset();
    await path(b);
    assert.ok(b.calls().length > 0, `the ring is on ${b.ringSurface()} and no keyboard call reached the host`);
    assert.equal(b.calls().at(-1), b.ringSurface(), "the keyboard and the ring disagree");
  });
}

test("a surface that no placement shows yet takes the keyboard when a placement shows it", { timeout: 5000 }, async () => {
  await b.reset();
  const tab = b.plane.addTabTo(b.plane.focused(), pluginId, null);
  await b.idle();
  assert.ok(!b.calls().includes(tab.tab ?? tab), "the keyboard went to a surface that no placement shows");
  await b.placed();
  assert.equal(b.calls().at(-1), b.ringSurface());
});

test("a press on a tab whose surface the host holds sends the call before the placement", { timeout: 5000 }, async () => {
  await b.reset();
  const card = b.plane.focused();
  b.plane.addTabTo(card, pluginId, null);
  await b.placed();
  const hidden = b.plane.currentGrid().card(card).data.tabs.map(({ id }) => id).find((id) => id !== b.ringSurface());
  b.forgetCalls();
  const tab = tabElement(hidden);
  press(tab, "pointerdown");
  await b.idle();
  assert.deepEqual(b.calls(), [hidden], "the keyboard call of the press waited for the placement");
  press(tab, "pointerup");
  await b.placed();
});

test("each decision of the keyboard is recorded with its cause", { timeout: 5000 }, async (t) => {
  await b.reset();
  b.watchDecisions(t);
  const before = b.ringSurface();
  b.plane.addTabTo(b.plane.focused(), pluginId, null);
  await b.idle();
  const added = b.ringSurface();
  assert.deepEqual((await b.decisions()).at(-1), { level: "debug", cause: "ring", target: added, sent: before, owed: true, decided: false, decision: "wait" },
    "the new tab waits for the placement that holds it");
  await b.placed();
  assert.equal((await b.decisions()).at(-1).cause, "placed");
  assert.equal((await b.decisions()).at(-1).decision, "send");
  b.keyboard.keyboardResponder({ owner: "workbench" });
  await b.idle();
  assert.deepEqual((await b.decisions()).at(-1), { level: "debug", cause: "responder", target: added, sent: added, owed: true, decided: false, decision: "send" });
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
    b.forgetEnds();
    press(target, "pointerdown");
    press(target, "pointerup");
    assert.deepEqual(b.ends(), [b.ringSurface()], "the release did not send its decided call to the ring in its dispatch");
    await b.placed();
    assert.equal(b.ends().length, 1, `the decided calls of the press: ${JSON.stringify(b.ends())}`);
  });
}

test("a release while the ring is on a surface that the host does not hold decides for the workbench", { timeout: 5000 }, async (t) => {
  await b.reset();
  b.watchDecisions(t);
  const before = b.ringSurface();
  b.plane.addTabTo(b.plane.focused(), pluginId, null);
  await b.idle();
  const added = b.ringSurface();
  b.forgetEnds();
  b.forgetCalls();
  press(document.body, "pointerdown");
  press(document.body, "pointerup");
  assert.deepEqual(b.ends(), [null], "the release did not send one decided call for the workbench in its dispatch");
  assert.deepEqual((await b.decisions()).at(-1), { level: "debug", cause: "press", target: null, sent: before, owed: true, decided: true, decision: "send" });
  await b.placed();
  assert.equal(b.calls().at(-1), added, "the placement that gave the host the surface did not move the keyboard to it");
  assert.deepEqual(b.ends(), [null], "the placement sent a second decided call");
});

test("a release while a keyboard call has no answer sends its decided call", { timeout: 5000 }, async () => {
  await b.reset();
  const release = holdFocus();
  b.plane.focusCard(otherCard(b));
  await b.idle();
  b.forgetEnds();
  press(document.body, "pointerdown");
  press(document.body, "pointerup");
  assert.deepEqual(b.ends(), [b.ringSurface()], "the decided call waited for the answer of the earlier keyboard call");
  release();
  await b.placed();
});

test("a release while a modal is open decides for the ring and the modal keeps the keyboard", { timeout: 5000 }, async (t) => {
  await b.reset();
  b.watchDecisions(t);
  b.overlay.show(b.menu, { x: 0, y: 0, w: 10, h: 10 }, () => {});
  await b.idle();
  b.forgetEnds();
  b.forgetCalls();
  press(document.body, "pointerdown");
  press(document.body, "pointerup");
  assert.deepEqual(b.ends(), [b.ringSurface()], "the release in a modal did not send one decided call for the ring");
  assert.equal((await b.decisions()).at(-1).decision, "modal");
  b.overlay.hide(b.menu);
  await b.idle();
  assert.equal(b.calls().at(-1), b.ringSurface(), "the close of the modal did not give the keyboard back to the ring");
});

test("the page never holds the input of the window", () => {
  const folder = new URL("../", import.meta.url);
  const sources = readdirSync(folder).filter((name) => name.endsWith(".js") || name.endsWith(".html"));
  const holds = sources.filter((file) => /keyboardHold|keyboardDecided/.test(readFileSync(new URL(file, folder), "utf8")));
  assert.deepEqual(holds, [], "a source sends a hold of the input or its end");
});

test("a modal keeps the keyboard until it closes", { timeout: 5000 }, async () => {
  await b.reset();
  b.overlay.show(b.menu, { x: 0, y: 0, w: 10, h: 10 }, () => {});
  b.forgetCalls();
  b.plane.focusCard(otherCard(b));
  await b.placed();
  assert.deepEqual(b.calls(), [], "the workbench moved the keyboard out of an open modal");
  b.overlay.hide(b.menu);
  await b.idle();
  assert.equal(b.calls().at(-1), b.ringSurface());
});

test("the library keeps the keyboard with the workbench", { timeout: 5000 }, async () => {
  await b.reset();
  b.plane.clear();
  await b.idle();
  assert.deepEqual(b.calls(), [null]);
});

test("a card without a surface leaves the keyboard with the workbench", { timeout: 5000 }, async () => {
  await b.reset();
  const missing = "fixture-not-installed";
  const card = b.plane.currentGrid().card(b.plane.focused());
  const orphan = { ...card.data.tabs[0], id: "tab-orphan", plugin: missing };
  b.plane.currentGrid().setData(card.id, { tabs: [...card.data.tabs, orphan], activeId: orphan.id });
  b.plane.focusCard(card.id);
  await b.idle();
  assert.equal(b.calls().at(-1), null);
});

test("an editable element of the workbench holds the keyboard while it has the focus", { timeout: 5000 }, async () => {
  await b.reset();
  const input = document.createElement("input");
  document.body.appendChild(input);
  b.forgetCalls();
  input.focus();
  await b.idle();
  assert.deepEqual(b.calls(), [null], "the rename field did not take the keyboard");
  b.keyboard.keyboardResponder({ owner: "workbench" });
  await b.idle();
  assert.deepEqual(b.calls(), [null], "the workbench took the keyboard from its own field");
  input.blur();
  input.remove();
  await b.idle();
  assert.equal(b.calls().at(-1), b.ringSurface());
});

test("a press on a tab leaves no element focus, and the Tab key keeps its stop", { timeout: 5000 }, async () => {
  await b.reset();
  const tab = tabElement(b.ringSurface());
  assert.ok(press(tab, "mousedown").defaultPrevented, "a press would move the DOM focus to the tab");
  // The Tab key moves the focus without a press, and a first responder in the workbench does not take that stop away.
  tab.tabIndex = 0;
  tab.focus();
  await b.idle();
  b.forgetCalls();
  b.keyboard.keyboardResponder({ owner: "workbench" });
  await b.idle();
  assert.deepEqual(b.calls(), []);
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
  assert.match(page, /held: \(surfaceIds\) => \{ hostHeld = surfaceIds; \}/);
  assert.match(page, /if \(record\.drawn\) await keyboardPlaced\([^\n]*, hostHeld\);/);
  // The field of a rename leaves the document in this draw, and a removal does not always report the lost focus.
  assert.match(page, /createBarTabs\(\{[^}]*keyboardOwed/);
  const barTabs = readFileSync(new URL("../bar-tabs.js", import.meta.url), "utf8");
  assert.equal(barTabs.match(/redraw\(\);\n\s+keyboardOwed\(\);/g)?.length, 2);
  const exposure = readFileSync(new URL("../core-exposure.js", import.meta.url), "utf8");
  assert.match(exposure, /keyboardResponder\(event\);/);
});

/** The case holds the answer of each keyboard call that the page sends from here until the returned function runs, which releases them. */
function holdFocus() {
  const from = wire.calls.length;
  return () => {
    for (const { name } of wire.calls.slice(from)) if (name === "surfaceFocus") wire.release();
  };
}

/** Answers a drawn placement and tells whether the placement ended before the host answered the keyboard call. */
async function placementEnd() {
  await b.idle();
  b.plane.settle();
  b.held()?.();
  await b.idle();
  let ended = false;
  const end = Promise.resolve(b.keyboard.keyboardPlaced(b.shownSurfaces(), b.heldSurfaces())).then(() => { ended = true; });
  await b.idle();
  return { end, ended: () => ended };
}

test("a placement ends when the host answered the keyboard call to the new tab", { timeout: 5000 }, async () => {
  await b.reset();
  const release = holdFocus();
  b.plane.addTabTo(b.plane.focused(), pluginId, null);
  const { end, ended } = await placementEnd();
  assert.equal(b.calls().at(-1), b.ringSurface(), "the placement sent no keyboard call to the new tab");
  assert.equal(ended(), false, "the placement ended before the host answered the keyboard call");
  release();
  await end;
});

test("a placement ends when the host answered the keyboard call that went before it", { timeout: 5000 }, async () => {
  await b.reset();
  const release = holdFocus();
  b.plane.focusCard(otherCard(b));
  await b.idle();
  assert.equal(b.calls().at(-1), b.ringSurface(), "the move of the ring sent no keyboard call ahead of the placement");
  const { end, ended } = await placementEnd();
  assert.equal(ended(), false, "the placement ended before the host answered the keyboard call");
  release();
  await end;
});

test("every step of the case was played", async () => {
  // The relay of the events that the page still holds ends before the case does, so no timer of the page sends a call afterwards.
  await b.flushEvents();
  wire.finish();
});
