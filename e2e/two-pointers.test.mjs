// Two named pointers press and drag at once, on two pages of one window and in two windows, and each page sees the buttons of
// its own gesture. A move of one pointer in a window in which the other pointer holds a press is refused with the holder and
// the reason named, because a window has one hover position (docs/spec/exposure.md#named-pointers).
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { documentPoint, focusedCard, inputProbeTab, readyInputProbe } from "./input-probe.mjs";

// The document region of the input probe counts its presses, the moves made with the primary button held, its releases, and the
// events whose buttons are not those of its own gesture (`pointer` of `probeinput.document`).

/** Empties the counts of the probe and returns the centre of its document region in window coordinates once it is shown. */
async function page(s, surface) {
  await s.run("probeinput.clear", {}, surface);
  await s.until("probeinput.document", (state) => state.pointer.downs === 0 && state.pointer.ups === 0,
    `the probe ${surface} did not clear its pointer counts`, { surface });
  await s.presented();
  const center = await documentPoint(s, surface);
  await s.until("host.window", (w) => w.documents.some((d) => d.surface === surface && d.visible),
    `the document region of ${surface} is not visible`);
  return center;
}

/** Waits until the document of the probe shows the counts of its gesture and no foreign button. */
function counted(s, surface, [downs, drags, ups], what) {
  const expected = { downs, drags, ups, foreign: 0 };
  return s.until("probeinput.document", (state) => state.pointer.downs === downs && state.pointer.drags === drags
    && state.pointer.ups === ups && state.pointer.foreign === 0, `${what}: the probe did not show ${JSON.stringify(expected)}`,
  { surface });
}

/** Presses with each pointer, drags each twice in turn and releases each, waiting for each page to count each step. */
async function gesture(first, second) {
  await first.s.pointer(first.at.x, first.at.y, "down", { pointer: first.name });
  await counted(first.s, first.surface, [1, 0, 0], `the press of pointer ${first.name}`);
  await second.s.pointer(second.at.x, second.at.y, "down", { pointer: second.name });
  await counted(second.s, second.surface, [1, 0, 0], `the press of pointer ${second.name}`);
  for (const step of [1, 2]) {
    for (const { s, surface, at, name, sign } of [first, second]) {
      await s.pointer(at.x + sign * 12 * step, at.y + 6 * step, "drag", { pointer: name });
      await counted(s, surface, [1, step, 0], `drag ${step} of pointer ${name}`);
    }
  }
  for (const { s, surface, at, name, sign } of [first, second]) {
    await s.pointer(at.x + sign * 24, at.y + 12, "up", { pointer: name });
    await counted(s, surface, [1, 2, 1], `the release of pointer ${name}`);
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: two pointers press and drag at once on two pages of one window`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const { surface: left, card } = await inputProbeTab(s);
    const { tab: right } = await s.run("core.card.split", { card, side: "right", plugin: "probeinput" });
    await readyInputProbe(s, right);
    const leftAt = await page(s, left);
    const rightAt = await page(s, right);
    await s.pointer(leftAt.x, leftAt.y, "move", { pointer: "first" });
    await s.until("host.window", (w) => w.virtualKey, "the window did not become the virtual key window");
    const first = { s, surface: left, at: leftAt, name: "first", sign: 1 };
    const second = { s, surface: right, at: rightAt, name: "second", sign: -1 };
    await first.s.pointer(leftAt.x, leftAt.y, "down", { pointer: "first" });
    await counted(s, left, [1, 0, 0], "the press of pointer first");
    await assert.rejects(s.pointer(rightAt.x, rightAt.y, "move", { pointer: "second" }), (error) => {
      assert.equal(error.code, 1011, error.message);
      assert.match(error.message, /pointer first holds a press that this input would share: the window has one hover position/);
      return true;
    });
    await s.pointer(leftAt.x, leftAt.y, "up", { pointer: "first" });
    await counted(s, left, [1, 0, 1], "the release of pointer first");
    await page(s, left);
    await gesture(first, second);
    const window = await s.get("host.window");
    assert.equal(window.active, false, "the application became active");
  });

  test(`${app.name}: two pointers press and drag at once in two windows`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const { surface: here } = await inputProbeTab(s);
    const hereAt = await page(s, here);

    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-two-pointers-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    s.cleanupSteps(
      async () => {
        for (const window of await s.get("host.windows")) {
          if (window.window !== s.window) await s.on(window.window).close();
        }
        await s.windows(1, "the check left an extra window");
      },
      async () => {
        for (const project of await s.get("core.projects")) {
          if (project.root === root) await s.run("core.project.close", { id: project.id });
        }
        await s.run("core.projects.flush");
      },
    );
    await s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" });
    await s.run("core.project.open", { root, color: "#7db4ff" });
    const windows = await s.windows(2, "the project window did not open");
    const other = s.on(windows.find((w) => w.window !== s.window).window);
    const grid = await other.until("core.grid", (value) => value?.cards?.some((card) => !card.fixed && card.tabs?.length),
      "the project window did not create a card with tabs");
    const { surface: there } = await inputProbeTab(other, { card: focusedCard(grid).id });
    const thereAt = await page(other, there);

    await s.pointer(hereAt.x, hereAt.y, "move", { pointer: "first" });
    await s.until("host.window", (w) => w.virtualKey, "the first window did not become the virtual key window");
    await gesture({ s, surface: here, at: hereAt, name: "first", sign: 1 },
      { s: other, surface: there, at: thereAt, name: "second", sign: -1 });
    for (const session of [s, other]) {
      assert.equal((await session.get("host.window")).active, false, "the application became active");
    }
  });
}
