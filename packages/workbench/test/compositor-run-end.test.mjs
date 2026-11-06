import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";

let compositor;
let runState;
let answers;
let ends;
const gesture = (on) => {
  const divider = document.querySelector(".sp-divider");
  if (on) divider.setAttribute("data-dragging", "true");
  else divider.removeAttribute("data-dragging");
};
const place = (record) => ({ placements: record.surfaces.map((surface) => ({ id: surface.id, ...surface.applied })), deferred: [] });

before(async () => {
  const dom = new JSDOM(`<div id="plane"><div class="sp-divider"></div><div data-card-id="card">
    <div data-native-surface data-native-surface-id="surface" data-native-plugin="probe" data-native-layer="0"></div>
  </div></div>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  const card = document.querySelector("[data-card-id]");
  const slot = document.querySelector("[data-native-surface]");
  card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 150 });
  slot.getBoundingClientRect = () => ({ left: 2, top: 30, width: 196, height: 100 });
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "probe", surface: () => ({ module: "probe.js", composition: { kind: "dom" } }) });
  compositor = await import("../compositor.js");
  runState = await import("../run-state.js");
  compositor.setSlotSurface(slot, { surfaceId: "surface", pluginId: "probe", composition: { kind: "dom" } });
  compositor.onCommit((record) => new Promise((resolve, reject) => {
    answers.push({ present: () => resolve(place(record)), fail: reject });
  }));
  runState.onRunEnd(() => { ends++; });
});

beforeEach(() => {
  answers = [];
  ends = 0;
});

test("a run ends when the settled layout has presented, so held work does not compete with that layout", async () => {
  gesture(true);
  const moving = compositor.publish();
  assert.equal(runState.runActive(), true, "a drawn layout of a gesture is part of a run");
  answers.shift().present();
  await moving;
  assert.equal(runState.runActive(), true, "the run continues while the gesture continues");

  gesture(false);
  const settled = compositor.publish();
  assert.equal(runState.runActive(), true, "the run continues until the settled layout has presented");
  assert.equal(ends, 0, "the listeners of the end of a run wait for the presentation");
  answers.shift().present();
  await settled;
  assert.equal(runState.runActive(), false, "the presentation of the settled layout ends the run");
  assert.equal(ends, 1);
});

test("a settled preparation keeps the run active until its drawing has presented", async () => {
  gesture(true);
  const moving = compositor.publish();
  answers.shift().present();
  await moving;

  gesture(false);
  const prepared = compositor.publishAhead(new Map(), new Map(), 0);
  answers.shift().present();
  await prepared;
  assert.equal(runState.runActive(), true, "a preparation shows nothing, so the run continues");

  const drawn = compositor.publish();
  answers.shift().present();
  await drawn;
  assert.equal(runState.runActive(), false);
  assert.equal(ends, 1);
});

test("a settled layout that fails ends the run and its caller still receives the failure", async () => {
  gesture(true);
  const moving = compositor.publish();
  answers.shift().present();
  await moving;

  gesture(false);
  const settled = compositor.publish();
  answers.shift().fail(new Error("placement refused"));
  await assert.rejects(settled, /placement refused/);
  assert.equal(runState.runActive(), false, "held work is not stranded by a failed layout");
  assert.equal(ends, 1);
});

test("a cancelled preparation ends a run that waited for its drawing", async () => {
  gesture(true);
  const moving = compositor.publish();
  answers.shift().present();
  await moving;

  gesture(false);
  const prepared = compositor.publishAhead(new Map(), new Map(), 0);
  answers.shift().present();
  await prepared;
  assert.equal(runState.runActive(), true);
  await compositor.cancelPrepared({ handover: false });
  assert.equal(runState.runActive(), false, "no drawing follows a cancelled preparation");
  assert.equal(ends, 1);
});

test("a gesture that continues before the settled layout has presented keeps its run", async () => {
  gesture(true);
  const moving = compositor.publish();
  answers.shift().present();
  await moving;

  gesture(false);
  const settled = compositor.publish();
  gesture(true);
  const again = compositor.publish();
  answers.shift().present();
  await settled;
  assert.equal(runState.runActive(), true, "the later gesture continues the run");
  assert.equal(ends, 0);
  answers.shift().present();
  await again;

  gesture(false);
  const last = compositor.publish();
  answers.shift().present();
  await last;
  assert.equal(runState.runActive(), false);
  assert.equal(ends, 1);
});
