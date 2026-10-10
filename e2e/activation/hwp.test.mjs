// HWP check in the active key window: native keys type at the caret of the editor in a document region, Shift-ArrowLeft selects
// the typed letter, a pointer drag selects text, and Command-S writes the file, which the surface reads back
// (docs/spec/native-surfaces.md#document-regions). Typed text reaches a document region only in the key window of the active
// application, so this check runs in the activation tier; e2e/hwp.test.mjs covers the opening while the application is inactive.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { lines, openHwp, sha, studio } from "../hwp-support.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: an hwp file takes native keys and a drag in the active key window and saves`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const { surface, file } = await openHwp(s);
    const region = await studio(s, surface);
    // The application becomes active and its window the key window before the press.
    await s.pointer(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height * 0.8, "move", { activate: true });
    await s.until("host.window", (state) => state.active && state.key, "the window did not become the active key window");
    // Activation and the change of the first responder can bring back the input source of the person, so the ABC source is
    // selected right before the keys.
    await s.selectInputSource("com.apple.keylayout.ABC");
    await s.click(region.frame.x + region.frame.width / 2, region.frame.y + region.frame.height * 0.8);
    await s.until("host.window", (value) => value.documents.some((item) => item.surface === surface && item.focused),
      "a press in the editor did not give it the keyboard focus");

    // A native key types at the caret, Shift-ArrowLeft selects the typed letter and ArrowRight ends the selection.
    await s.press("x");
    await s.until("hwp.document", (value) => value.modified, "a native key did not edit the document", { surface }).catch(async (error) => {
      const { key, active, responder, documents, input } = await s.get("host.window");
      error.message += `; host.window ${JSON.stringify({ key, active, responder, documents, input })}`;
      throw error;
    });
    await s.press("ArrowLeft", { modifiers: ["shift"] });
    await s.until("hwp.document", (value) => value.selection, "Shift-ArrowLeft selected nothing", { surface });
    assert.equal((await s.run("hwp.request", { method: "getSelectionContext" }, surface)).selectedTextSha256, sha("x"));
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
}
