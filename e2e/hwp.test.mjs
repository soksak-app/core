// HWP check while the application is inactive: an .hwp file opens from the file tree in the plugin whose surface.opens declares
// hwp, which shows the editor of its package in a document region and exchanges messages with it
// (docs/spec/native-surfaces.md#document-regions). The pages draw their text, and a native press on the page gives the editor
// the keyboard focus. On the virtual key window native keys with their stated text type at the caret, Shift-ArrowLeft selects
// the typed letter, a pointer drag selects text, and Command-S writes the file, which the surface reads back
// (docs/spec/exposure.md#virtual-key-window).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { openRecordedView, viewCardWithDifferentPluginTab } from "./view-metrics-collection.mjs";
import { lines, openHwp, sha, studio } from "./hwp-support.mjs";
import { hwpFirstDisplayLimitMs, hwpViewDescriptor } from "./benchmark/cases/hwp.mjs";
import { collectHwpStartupResourceEvidence } from "./hwp-startup.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: an hwp file opens from the tree, draws its pages and takes the keyboard focus on a press`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { performanceTrace: true });
    const { surface } = await openHwp(s);
    // A press on the page in the region gives the editor the keyboard focus and places its caret.
    const region = await studio(s, surface);
    await s.click(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height * 0.8);
    await s.until("host.window", (value) => value.documents.some((item) => item.surface === surface && item.focused),
      "a press in the editor did not give it the keyboard focus");
  });

  test(`${app.name}: an hwp file takes native keys and a drag on the virtual key window and saves`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const { surface, file } = await openHwp(s);
    const region = await studio(s, surface);
    // A pointer move that presses nothing makes the window the virtual key window.
    await s.pointer(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height * 0.8, "move");
    await s.until("host.window", (state) => state.virtualKey, "the window did not become the virtual key window");
    await s.click(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height * 0.8);
    await s.until("host.window", (value) => value.documents.some((item) => item.surface === surface && item.focused),
      "a press in the editor did not give it the keyboard focus");

    // A native key with its stated text types at the caret, Shift-ArrowLeft selects the typed letter and ArrowRight ends the
    // selection.
    await s.press("x", { text: "x" });
    await s.until("hwp.document", (value) => value.modified, "a native key did not edit the document", { surface }).catch(async (error) => {
      const { key, virtualKey, active, responder, documents, input } = await s.get("host.window");
      error.message += `; host.window ${JSON.stringify({ key, virtualKey, active, responder, documents, input })}`;
      throw error;
    });
    await s.press("ArrowLeft", { modifiers: ["shift"] });
    await s.until("hwp.document", (value) => value.selection, "Shift-ArrowLeft selected nothing", { surface });
    // The editor answers the selection only as a hash, so a different selection states the page text and the whole context.
    const selected = await s.run("hwp.request", { method: "getSelectionContext" }, surface);
    if (selected.selectedTextSha256 !== sha("x")) {
      assert.fail(`Shift-ArrowLeft after x selected text of SHA-256 ${selected.selectedTextSha256}, not x; selection context ` +
        `${JSON.stringify(selected)}; page ${JSON.stringify(await lines(s, surface))}`);
    }
    await s.press("ArrowRight");
    await s.until("hwp.document", (value) => !value.selection, "ArrowRight did not end the selection", { surface });

    // A pointer drag from the point of the first press to the left along the same line selects text of that line.
    const line = region.frame.y + region.frame.height * 0.8;
    // Each step waits until the window has presented the previous one, as a person's drag reaches the editor.
    await s.pointer(region.frame.x + region.frame.width / 2, line, "down");
    await s.presented();
    await s.pointer(region.frame.x + region.frame.width * 0.3, line, "drag");
    await s.presented();
    await s.pointer(region.frame.x + region.frame.width * 0.2, line, "drag");
    await s.presented();
    await s.pointer(region.frame.x + region.frame.width * 0.2, line, "up");
    await s.until("hwp.document", (value) => value.selection, "a pointer drag selected nothing", { surface });
    await s.press("ArrowRight");
    await s.until("hwp.document", (value) => !value.selection, "ArrowRight did not end the drag selection", { surface });

    // Command-S in the editor writes the file, and reading it again keeps the typed letter.
    const before = readFileSync(file);
    await s.press("s", { modifiers: ["command"] });
    await s.until("hwp.document", (value) => !value.modified, "Command-S did not save", { surface });
    assert.notDeepEqual(readFileSync(file), before, "the file did not change on disk");
    await s.run("hwp.reload", {}, surface);
    const saved = await lines(s, surface);
    assert.equal(saved.join("").replace("x", ""), "속삭한글문서확인둘째문단입니다.", `the saved text is ${JSON.stringify(saved)}`);
    assert.equal(saved.join("").split("x").length, 2, `the saved text is ${JSON.stringify(saved)}`);
  });

  test(`${app.name}: HWP startup resource timing snapshot is preserved`, { timeout: 180000 }, async (t) => {
    const runFolder = process.env.SOKSAK_RUN_FOLDER;
    if (typeof runFolder !== "string" || runFolder.length === 0) {
      throw new Error("SOKSAK_RUN_FOLDER is required to preserve HWP resource timing evidence");
    }
    mkdirSync(runFolder, { recursive: true });
    const evidencePath = join(runFolder, `hwp-resource-timing-${app.name}.json`);
    t.diagnostic(`HWP resource timing evidence ${evidencePath}`);
    const evidence = { app: app.name, format: 2, errors: [] };
    const persist = () => writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    let opened;
    let descriptor;
    const s = await open(t, app);
    try {
      await fresh(s, {
        performanceTrace: true,
        log: { lifecycle: "info" },
        reads: [
          "host.trace.view.process-request",
          "host.trace.view.process-ready",
          "plugin.hwp.phase",
          "plugin.hwp.request",
        ],
      });
      descriptor = await hwpViewDescriptor(s, (message) => t.diagnostic(message),
        hwpFirstDisplayLimitMs(app.name));
      assert.ok(descriptor.params?.path, "HWP resource timing fixture has no document path");
      const grid = await s.get("core.grid");
      const card = viewCardWithDifferentPluginTab(grid, "hwp", grid.cards.find((item) => item.active)?.id);
      opened = await openRecordedView(t, s, { card, ...descriptor, deferContentVerification: true });
    } catch (error) {
      evidence.errors.push({ step: "open", message: String(error?.message ?? error) });
      persist();
      throw error;
    }

    await collectHwpStartupResourceEvidence(s, opened, {
      app: app.name,
      path: descriptor.params.path,
      evidence,
      persist,
      recordingCopyDirectory: join(runFolder, `capture-${app.name}`),
    });
  });
}
