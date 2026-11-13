// The statuses of the workbench describe the workbench of the window, not a page (docs/spec/exposure.md#workbench-statuses):
// core.window.workbench names one start of the workbench, core.workbench.error its shown error and core.workbench.audit its
// operable elements without a command or an element name. The page names that they replace are not declared.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { EXPOSURE_ERRORS } from "@soksak/plugin-api";
import { selectPageWire } from "@soksak/runtime";

test("core.window.workbench, core.workbench.error and core.workbench.audit describe the workbench and the page names are refused", { timeout: 5000 }, async () => {
  // The case selects the host of the page before the modules below are imported, because the page reads the host when it is imported.
  const wire = selectPageWire("workbench-statuses-notifications");
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  globalThis.devicePixelRatio = 2;
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 800;
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { pageIdentity } = await import("../page-identity.js");
  const { installCoreExposure, setVerify } = await import("../core-exposure.js");
  const get = (name) => registry.handle({ method: "status.get", params: { name } });
  try {
    await installCoreExposure({
      library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
    });

    const { result: workbench } = await get("core.window.workbench");
    assert.deepEqual(Object.keys(workbench),
      ["start", "startedAt", "readyState", "visibility", "scheme", "background", "scale", "width", "height"]);
    assert.equal(workbench.start, pageIdentity, "start is the page identity of the main page on this host");
    assert.equal(workbench.startedAt, performance.timeOrigin, "startedAt is the time origin of the main page on this host");
    assert.deepEqual([workbench.scale, workbench.width, workbench.height], [2, 1200, 800]);

    setVerify([{ name: "V1", ok: true, note: "a" }, { name: "V7c", skipped: true, note: "b" }, { name: "V2", ok: false, note: "c" }]);
    assert.deepEqual(await get("core.verify"), { result: {
      failed: 1,
      rows: [{ name: "V1", ok: true, note: "a" }, { name: "V2", ok: false, note: "c" }],
      skipped: [{ name: "V7c", note: "b" }],
    } }, "a skipped check is neither a row nor a failure");

    assert.deepEqual(await get("core.workbench.error"), { result: null }, "a workbench that shows no error reports null");
    const shown = document.createElement("div");
    shown.id = "applicationError";
    shown.textContent = "the layout cannot be drawn";
    document.body.append(shown);
    assert.deepEqual(await get("core.workbench.error"), { result: "the layout cannot be drawn" });

    const loose = document.createElement("button");
    loose.textContent = "Loose";
    document.body.append(loose);
    const { result: audit } = await get("core.workbench.audit");
    assert.deepEqual(audit.unbound.filter((row) => row.text === "Loose"),
      [{ role: "button", expose: null, command: null, text: "Loose" }]);

    await assert.rejects(registry.run("core.focus.set", { name: "core.fixture.absent", index: 0 }), /^Error: unknown element core\.fixture\.absent$/);
    await assert.rejects(registry.run("core.focus.set", { name: "core.brand", index: 9 }), /^Error: element core\.brand has no element at index 9$/);

    // The host asks the last placement of the workbench before it waits for the presentation of the window; a workbench
    // that has not placed a layout answers at once.
    assert.deepEqual(await registry.handle({ method: "workbench.placement.last" }), { result: null });

    for (const name of ["core.window.document", "core.page.error", "core.page.audit"]) {
      assert.equal((await get(name)).error?.code, EXPOSURE_ERRORS.unknownName, `${name} is still declared`);
    }
    wire.finish();
  } finally {
    dom.window.close();
  }
});
