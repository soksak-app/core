import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import exposureFile from "../exposure.json" with { type: "json" };

// The core update is the first row of the update list of the plugin page (docs/spec/installation.md#application-update).
test("the update list shows the core update first with its release link, its action and the steps of the operation", async () => {
  // The host calls and events of the page are answered by the page-wire case (docs/spec/cases/page-wire/README.md). The case is selected before the
  // modules of the library are imported, because the page reads the host when its modules are imported.
  const wire = selectPageWire("library-app-update-operations");
  const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.devicePixelRatio = dom.window.devicePixelRatio;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  // The operation of the update is an info event of the class call, which the gate stores for this test; the other classes store errors only.
  const { logGate } = await import("../log-gate.js");
  logGate.set({ lifecycle: "error", input: "error", call: "info", io: "error", frame: "error" });
  const { installExposure } = await import("../exposure.js");
  installExposure(exposureFile);
  const { appUpdate } = await import("../installed-plugins.js");
  const { createLibrary } = await import("../library.js?app-update");
  const { flushEvents } = await import("../page-log.js");
  const root = document.createElement("div");
  document.body.append(root);
  const library = createLibrary(root);
  // The replies of the host are settled after the turn of the page that sent their calls.
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  try {
    library.actions.page("plugins");
    await settled();
    const row = () => root.querySelector('[data-expose="core.library.app.row"]');
    const list = root.querySelector(".library-updates");
    assert.equal(list.firstElementChild, row(), "the core update is not the first row of the update list");
    assert.equal(row().querySelector("p").textContent, "core: 0.0.8 → 0.0.9");
    const buttons = [...row().querySelectorAll("button")].map((b) => [b.textContent, b.dataset.expose, b.dataset.command]);
    assert.deepEqual(buttons, [
      ["릴리스 페이지", "core.library.app.release", "core.app.release"],
      ["업데이트", "core.library.app.update", "core.app.update"],
    ]);
    assert.equal(root.querySelector('[data-expose="core.library.app.operation"]'), null);
    // A plugin that the candidate does not contain is listed under the row with its newest version that does, in the order of its id.
    const incompatible = [...row().querySelectorAll('[data-expose="core.library.app.incompatible"]')].map((item) => item.textContent);
    assert.deepEqual(incompatible, [
      "notes 1.0.0 (0.0.8): 0.0.9에 맞는 버전 없음",
      "tty 0.2.0 (0.0.8): 0.0.9에 맞는 최신 버전 0.3.0",
    ]);

    // A candidate without a release page offers no link.
    await appUpdate.refresh();
    library.render();
    assert.deepEqual([...row().querySelectorAll("button")].map((b) => b.dataset.expose), ["core.library.app.update"]);
    // Without a candidate the list has no core row.
    await appUpdate.refresh();
    library.render();
    assert.equal(row(), null);
    await appUpdate.refresh();
    library.render();

    // The steps of the operation and its error are shown on the row. The stage call is held until the test releases it.
    const staged = appUpdate.update();
    await settled();
    library.render();
    assert.equal(root.querySelector('[data-expose="core.library.app.operation"]').textContent, "0.0.9 받는 중");
    wire.release();
    await settled();
    library.render();
    assert.equal(root.querySelector('[data-expose="core.library.app.operation"]').textContent, "0.0.9 적용하는 중");
    wire.release();
    await assert.rejects(staged, /application update: sha256 differs/);
    await settled();
    library.render();
    const failed = root.querySelector('[data-expose="core.library.app.operation"]');
    assert.equal(failed.textContent, "0.0.9 업데이트하지 못했습니다: application update: sha256 differs");
    assert.equal(failed.getAttribute("role"), "alert");
    await flushEvents();
    wire.finish();
  } finally {
    dom.window.close();
  }
});
