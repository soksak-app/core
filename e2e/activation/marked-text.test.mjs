// Activation-tier window check: confirms that, when the composition of a macOS Japanese input method that uses marked text ends, the terminal writes that string
// to the PTY exactly once (F8-7).
//
// The Japanese (romaji) input method keeps the typed kana as marked text (and converts it to kanji when live conversion is on),
// and ends the composition when the input source changes. The expected committed string is the marked text that the input method reported last. This check
// activates the app and takes the user's focus, switches the input source through diagnostics.input.source of the diagnostic build,
// and restores the previous input source at the end. It fails when the input source is not enabled. A run that the user approved runs it
// only through pnpm -F @soksak/e2e verify:activation.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";
import { assertInputTraceDelivery, inputTraceTransactions } from "./terminal-ime-document.mjs";

const ABC = "com.apple.keylayout.ABC";
const JAPANESE = "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese";

for (const app of Object.values(APPS)) {
  test(`${app.name}: marked text that the input method ends is written to the PTY once`,
    { timeout: 60000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s);
      const [terminal] = await ensureTerminals(s, 1);
      const surface = terminal.surface;
      await readScreenUntil(s, surface, (lines) => lines.some((line) => /[$%#>]$/.test(line)),
        "the shell prompt did not appear");

      const original = (await s.request("diagnostics.input.source")).current;
      s.cleanup(() => s.request("diagnostics.input.source", { select: original }));

      // The key window receives the pointer position as a movement, so the window is placed away from the pointer.
      await s.keepPointerOutside();
      const view = await s.rect("terminal.view", undefined, surface);
      const x = view.document.x + view.x + view.width / 2;
      const y = view.document.y + view.y + view.height / 2;
      await s.pointer(x, y, "move", { activate: true });
      await s.click(x, y);
      await s.until("host.window", (host) => host.active === true &&
        host.regions.some((region) => region.surface === surface && region.focused),
      "the terminal did not receive native focus in the active window");

      await s.run("terminal.ime.trace", { action: "start" }, surface);
      s.cleanup(() => s.run("terminal.ime.trace", { action: "stop" }, surface));

      assert.equal((await s.request("diagnostics.input.source", { select: JAPANESE })).current, JAPANESE,
        `the ${JAPANESE} input source is not enabled`);
      for (const key of ["n", "i", "h", "o", "n", "n"]) await s.press(key);
      // No romaji remains in the marked text after the last n.
      const marked = (await s.until("terminal.compose", (compose) => compose.text.length > 0 && !/[a-z]/.test(compose.text),
        "the input method did not show marked text for nihonn", { surface })).text;
      const screen = await s.get("terminal.screen", surface);
      assert.ok(!screen.some((cells) => cells.map((cell) => cell.ch).join("").includes(marked)),
        "marked text reached the PTY before the composition ended");

      // When the input source changes, the input method ends the composition and AppKit commits the marked text.
      assert.equal((await s.request("diagnostics.input.source", { select: ABC })).current, ABC);
      await s.until("terminal.compose", (compose) => compose.text === "",
        "the ended composition left a preedit", { surface });
      const composing = await s.get("terminal.ime.trace", surface);
      const composingTransactions = inputTraceTransactions(composing.entries);
      const expected = composingTransactions.native.map((entry) => entry.preedit.text).filter((text) => text !== "").at(-1);
      assert.ok(expected, "the trace has no marked text");
      await readScreenUntil(s, surface, (lines) => lines.some((line) => line.trimEnd().endsWith(expected)),
        `the ended composition did not write ${expected} to the PTY`);
      await s.press("Enter");
      const output = await readScreenUntil(s, surface,
        (lines) => lines.some((line) => line.includes(`${expected}: command not found`)),
        "the shell did not run the committed text");
      const commandRows = output.filter((line) => line.includes(expected));
      assert.ok(commandRows.every((line) => line.split(expected).length === 2),
        `the committed text was repeated: ${JSON.stringify(commandRows)}`);

      const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
      assert.equal(trace.overflow, false, "the IME trace overflowed");
      const { native, terminal: terminalRequests } = assertInputTraceDelivery(trace.entries);
      const composed = native.filter((entry) => entry.preedit.text !== "");
      const inserts = native.filter((entry) => entry.actions.some((action) => action.type === "insert"));
      const written = terminalRequests.flatMap((entry) => entry.actions.filter((action) => action.type === "insert")
        .map((action) => action.text));
      t.diagnostic(`${app.name}: marked ${JSON.stringify(composed.map((entry) => entry.preedit.text))}, native inserts ${JSON.stringify(inserts.flatMap((entry) => entry.actions.filter((action) => action.type === "insert").map((action) => action.text)))}, terminal inserts ${JSON.stringify(written)}`);
      assert.deepEqual(inserts.flatMap((entry) => entry.actions.filter((action) => action.type === "insert")
        .map((action) => action.text)), [expected], "the native client did not commit the marked text exactly once");
      assert.deepEqual(written, [expected], "the terminal input queue did not write the marked text exactly once");
      const commit = inserts[0].sequence;
      assert.ok(!native.some((entry) => entry.sequence > commit && entry.preedit.text !== ""),
        "a preedit followed the commit");
      t.diagnostic(`${app.name}: PASS ${expected} committed once`);
    });
}
