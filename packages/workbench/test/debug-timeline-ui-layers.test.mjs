import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { open } from "./support/debug-timeline.mjs";

test("the layer choices of the timeline are every layer of the event contract, the workbench included, and the declarations list the same", async () => {
  const { ui, wire, close } = await open("debug-timeline-ui-layers");
  try {
    await ui.showDebugTimeline();
    const layers = ["all", "native", "host", "workbench", "page", "plugin", "sidecar", "sok"];
    const select = document.querySelector('[data-expose="core.debug.timeline.layer"]');
    assert.deepEqual([...select.querySelectorAll("option")].map((option) => option.value), layers);
    const exposure = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8"));
    const status = exposure.exposes.status.find(({ name }) => name === "core.debug");
    const command = exposure.exposes.commands.find(({ name }) => name === "core.debug.timeline.filter");
    assert.deepEqual(status.schema.properties.timeline.properties.layer.enum, layers);
    assert.deepEqual(command.params.properties.layer.enum, layers);
    await ui.filterDebugTimeline({ layer: "workbench" });
    assert.equal(ui.debugState().timeline.layer, "workbench");
  } finally {
    await close();
  }
  wire.finish();
});
