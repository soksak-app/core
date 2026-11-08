// Probes of native-menu and modal key routing from a focused plugin view. The window takes the presses and the keys as the
// virtual key window, and a key equivalent reaches the menu through the same path as in the key window of the active
// application, so the application and the input source of the person stay as they are
// (docs/spec/exposure.md#virtual-key-window). The input probe carries the view: its native document region reports the keys that
// reach it, and the text field of its view reports its focus, value and caret.
import assert from "node:assert/strict";
import test from "node:test";

import { currentEventOffsets, readEvents, untilEventLine, untilEventLines } from "@soksak/window-check/event-log.mjs";
import { APPS, MAIN_PAGE_APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { pasteboardText, writePasteboard } from "@soksak/window-check/pasteboard.mjs";
import { fresh, reading, settingsShown } from "./fixture.mjs";
import { documentPoint, fieldPoint, inputProbeTab } from "./input-probe.mjs";

const REGISTRY_COMMAND = "workbench.command";
const MODAL_ANSWER = "workbench.trace.modal.answer";
const PICKER_CLOSE = "workbench.trace.picker.close";
const INPUT_INJECTION = "native.record.info";
const READS = [REGISTRY_COMMAND, MODAL_ANSWER, PICKER_CLOSE, "workbench.input.shortcut.failed", INPUT_INJECTION,
  "native.input.key_down"];

async function openProbe(t, app, options) {
  const s = await open(t, app, { ...options, inactive: true });
  await fresh(s, { performanceTrace: true, log: { input: "info", lifecycle: "info", call: "debug" }, reads: READS });
  await keepCommonSettings(s);
  s.cleanup(async () => {
    if ((await s.get("host.window")).modal?.id === "settings") await s.run("core.settings.close");
    if ((await s.get("core.picker")).open) await s.run("core.picker.close");
    if ((await s.get("core.screen")).screen === "library") {
      await s.run("core.library.page", { page: "projects" });
      await s.run("core.library.return");
    }
  });
  return s;
}

async function traceEvents(s, offsets) {
  await s.flushLog();
  return readEvents(s.app.configDir, offsets).events;
}

function traceCommands(events, name) {
  return events.filter((event) => event.event === REGISTRY_COMMAND && event.fields?.name === name);
}

// The runs of the command written after offsets. A command writes its record when it answers, after the frame and the host calls
// of its change (docs/spec/logging.md#entrances), so the status that the change set comes before the record; the count
// waits for the first record of the command.
async function commandRuns(s, offsets, name) {
  await untilEventLine(s.app.configDir, offsets, (line) => line.includes(` ${REGISTRY_COMMAND}: `)
    && JSON.parse(line.slice(line.indexOf("{"))).name === name, 15000, reading(s.app, [REGISTRY_COMMAND]));
  return traceCommands(await traceEvents(s, offsets), name).length;
}

function assertNoViewKeydown(events, after, label) {
  const forwarded = events.filter((event) => event.sequence > after && event.type === "keydown");
  assert.deepEqual(forwarded, [], `${label}: native input reached the plugin view: ${JSON.stringify(forwarded)}`);
}

// Gives the keyboard to the native document region of a new input probe tab, as a press of a person on the virtual key window.
async function focusedDocument(s) {
  const { surface } = await inputProbeTab(s);
  const point = await documentPoint(s, surface);
  // A pointer move that presses nothing makes the window the virtual key window.
  await s.pointer(point.x, point.y, "move");
  await s.until("host.window", (window) => window.virtualKey, "the window did not become the virtual key window");
  await s.click(point.x, point.y);
  await s.until("host.window", (window) => window.virtualKey && window.responder?.surface === surface
    && window.documents.some((item) => item.surface === surface && item.focused),
  "the probe document did not become the first-responder owner of the virtual key window");
  return { surface };
}

// The keys down that the probe document received after the key `after`.
async function documentKeysAfter(s, surface, after) {
  return (await s.get("probeinput.document", surface)).keys.filter((key) => key.sequence > after && key.type === "keydown");
}

// The sequence of the last key of the probe document.
const lastDocumentKey = async (s, surface) => (await s.get("probeinput.document", surface)).keys.at(-1)?.sequence ?? 0;

/** The text of the view field that the routing cases copy. */
const ROUTING_TEXT = "routing-sentinel";

// Gives the keyboard to the text field of the view of a new input probe tab, as a press of a person on the virtual key window,
// with the field holding ROUTING_TEXT.
async function focusedField(s) {
  const { surface } = await inputProbeTab(s);
  await s.run("probeinput.select", { target: "field", value: ROUTING_TEXT, start: ROUTING_TEXT.length }, surface);
  const field = await fieldPoint(s, surface);
  // A pointer move that presses nothing makes the window the virtual key window.
  await s.pointer(field.x, field.y, "move");
  await s.until("host.window", (window) => window.virtualKey, "the probe window did not become the virtual key window");
  await s.click(field.x, field.y);
  await s.until("host.window", (window) => window.responder?.surface === surface,
    "the probe view did not become the first-responder owner");
  await s.until("probeinput.field", (value) => value.focused && value.value === ROUTING_TEXT,
    "the probe field did not report its focus and its text", { surface });
  return { surface };
}

function injectedKeyEvents(events, key) {
  return events.filter((event) => {
    if (event.event !== INPUT_INJECTION || event.fields?.where !== "input inject") return false;
    try {
      const input = JSON.parse(event.fields.text);
      return input.kind === "key" && input.key === key;
    } catch (error) {
      throw new Error(`native input injection record is invalid JSON: ${event.fields.text}`, { cause: error });
    }
  });
}

function assertDeliveredKey(events, key, label, { downResponder } = {}) {
  const records = injectedKeyEvents(events, key).map((event) => JSON.parse(event.fields.text));
  assert.deepEqual(records.map(({ down, result }) => ({ down, result })), [
    { down: true, result: "delivered" }, { down: false, result: "delivered" },
  ], `${label}: native input did not deliver both ${key} phases`);
  assert.ok(records.every((record) => record.keyWindow), `${label}: input was not delivered to the key window`);
  if (downResponder !== undefined) {
    const keyDown = records.find((record) => record.down);
    assert.equal(keyDown?.responder, downResponder,
      `${label}: keydown did not reach ${downResponder}: ${JSON.stringify(records)}`);
  }
}

// A key pressed while the picker loads waits for the picker and never reaches the view behind it
// (docs/spec/native-modals.md#keyboard). The diagnostic hold of the modal document keeps the picker loading, so the check runs on
// the applications that create modal web views (MAIN_PAGE_APPS); e2e/modal-escape-keys.test.mjs presses a key as the picker
// opens on every application.
for (const app of MAIN_PAGE_APPS) {
  test(`${app.name}: an Escape pressed while the page picker loads dismisses the picker once`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    const { surface } = await focusedDocument(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    assert.ok(card, "the probe has no owning card");

    let held = false;
    try {
      await s.request("diagnostics.modal.hold", { on: true });
      held = true;
      await s.run("core.card.menu", { card: card.id, menu: "add" });
      await s.until("core.picker", (picker) => picker.open, "the held page picker did not open");
      await s.request("diagnostics.modal.held");
      const offsets = currentEventOffsets(s.app.configDir);
      const before = await lastDocumentKey(s, surface);
      await s.press("Escape");
      // A key that waits is recorded at its turn, so no record of the Escape exists while the picker loads.
      const waiting = await traceEvents(s, offsets);
      assert.deepEqual(injectedKeyEvents(waiting, "Escape").map((event) => JSON.parse(event.fields.text)), [],
        "the Escape reached the window before the loading picker took the keyboard");
      assert.equal((await s.get("core.picker")).open, true, "the Escape closed the picker before it took the keyboard");
      await s.request("diagnostics.modal.hold", { on: false });
      held = false;
      await s.until("core.picker", (picker) => !picker.open, "the Escape that waited did not dismiss the picker");
      const events = await traceEvents(s, offsets);
      assertDeliveredKey(events, "Escape", "loading page-picker Escape");
      const reached = injectedKeyEvents(events, "Escape").map((event) => JSON.parse(event.fields.text).responder);
      assert.deepEqual(await documentKeysAfter(s, surface, before), [],
        `the Escape that waited reached the probe document: ${JSON.stringify(reached)}`);
      assert.equal(traceCommands(events, "core.picker.close").length, 0,
        "the Escape that waited must not run the view's core.picker.close command");
      assert.equal(await commandRuns(s, offsets, "core.modal.dismiss"), 1,
        "the Escape that waited must answer core.modal.dismiss once");
      assert.equal(events.filter((event) => event.event === PICKER_CLOSE
        && event.fields?.reason === "dismiss").length, 1,
      "the page picker must close once with reason dismiss");
    } finally {
      try {
        if (held) await s.request("diagnostics.modal.hold", { on: false });
      } finally {
        if ((await s.get("core.picker")).open) await s.run("core.picker.close");
      }
    }
  });
}

// A host with a main page (`pageProcess` of `host.window`) shows a modal in a modal web view, which takes the keyboard and answers
// the main page through the modal answer channel; the mygo host draws the modal in the window, whose workbench keeps the keyboard
// and runs core.picker.close for Escape (docs/spec/native-modals.md, docs/spec/exposure.md#keyboard-shortcuts).
for (const app of Object.values(APPS)) {
  test(`${app.name}: native picker Escape dismisses its modal once`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    const { surface } = await focusedDocument(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    assert.ok(card, "the probe has no owning card");
    await s.run("core.card.menu", { card: card.id, menu: "add" });
    await s.until("core.picker", (picker) => picker.open, "the native picker did not open");
    const webView = (await s.get("host.window")).pageProcess !== null;
    if (webView) {
      await s.until("host.window", (window) => window.modal?.id === "picker" && window.modal.shown,
        "the native picker did not become visible");
      await s.until("core.modal", (modal) => modal?.id === "picker" && modal.document !== null,
        "the native picker document did not render");
    } else {
      await s.until("core.modal", (modal) => modal?.id === "picker", "the native picker is not the open modal");
    }
    const nativePicker = await s.get("host.window");
    assert.equal(nativePicker.responder?.owner, webView ? "modal" : "workbench",
      `the ordinary picker does not own keyboard focus: ${JSON.stringify(nativePicker.responder)}`);
    const offsets = currentEventOffsets(s.app.configDir);
    const before = await lastDocumentKey(s, surface);
    await s.press("Escape");
    await s.until("core.picker", (picker) => !picker.open, "native picker Escape did not close the picker");
    const events = await traceEvents(s, offsets);
    assertDeliveredKey(events, "Escape", "native picker Escape");
    const reached = injectedKeyEvents(events, "Escape").map((event) => JSON.parse(event.fields.text).responder);
    assert.deepEqual(await documentKeysAfter(s, surface, before), [],
      `native picker Escape reached the probe document: ${JSON.stringify(reached)}`);
    if (!webView) {
      // The workbench draws the picker and holds the keyboard, so the Escape row of the picker layer runs core.picker.close
      // (docs/spec/exposure.md#keyboard-shortcuts); the view behind it received no Escape, as the responders above show.
      assert.equal(await commandRuns(s, offsets, "core.picker.close"), 1, "native picker Escape must run core.picker.close once");
      assert.equal(traceCommands(await traceEvents(s, offsets), "core.modal.dismiss").length, 0,
        "native picker Escape must not answer core.modal.dismiss without a modal web view");
    } else {
      assert.equal(traceCommands(events, "core.picker.close").length, 0,
        "native picker Escape must not run the view's core.picker.close command");
      assert.equal(await commandRuns(s, offsets, "core.modal.dismiss"), 1,
        "native picker Escape must answer core.modal.dismiss once");
      assert.equal(events.filter((event) => event.event === MODAL_ANSWER
        && event.fields?.key === "core.modal.dismiss").length, 1,
      "the native picker must answer Escape once");
      assert.equal(events.filter((event) => event.event === PICKER_CLOSE
        && event.fields?.reason === "dismiss").length, 1,
      "the native picker must close once with reason dismiss");
    }
  });

  test(`${app.name}: settings dialog Escape stays with the native modal responder`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    await focusedDocument(s);
    await s.run("core.settings.open");
    const webView = (await s.get("host.window")).pageProcess !== null;
    await settingsShown(s, "the settings dialog was not shown");
    const owner = webView ? "modal" : "workbench";
    const modalWindow = await s.get("host.window");
    assert.equal(modalWindow.responder?.owner, owner,
      `the settings dialog does not own keyboard focus: ${JSON.stringify(modalWindow.responder)}`);
    const offsets = currentEventOffsets(s.app.configDir);
    await s.press("Escape");
    // The input-injection record is emitted after AppKit's synchronous sendEvent dispatch returns.
    await untilEventLines(s.app.configDir, offsets,
      (lines) => lines.filter((line) => line.includes("native input inject:")
        && line.includes("Escape") && line.includes("delivered")).length >= 2,
      15000, reading(s.app, [INPUT_INJECTION]));
    const events = await traceEvents(s, offsets);
    const deliveredEscape = injectedKeyEvents(events, "Escape");
    assert.equal(deliveredEscape.length, 2, "the completed Escape press must contain down and up delivery records");
    assert.deepEqual(deliveredEscape.map((event) => {
      const input = JSON.parse(event.fields.text);
      return { down: input.down, result: input.result };
    }), [{ down: true, result: "delivered" }, { down: false, result: "delivered" }],
    "AppKit did not complete delivery of both Escape phases");
    assert.equal((await s.get("core.modal"))?.id, "settings", "Escape closed the native settings dialog");
    assert.equal((await s.get("host.window")).responder?.owner, owner, "Escape moved focus away from the settings dialog");
    assertDeliveredKey(events, "Escape", "settings dialog Escape");
    assert.equal(traceCommands(events, "core.picker.close").length, 0,
      "settings dialog Escape must not run a page picker command");
  });

  test(`${app.name}: native cmd+c copies selected view field text without view keydown`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app, { clipboard: true });
    const probe = await focusedField(s);
    const field = await s.get("probeinput.field", probe.surface);
    assert.equal(field.value, ROUTING_TEXT, "the view field does not contain the declared routing text");
    const before = await s.get("core.surface.input", probe.surface);
    writePasteboard([{ "public.utf8-plain-text": Buffer.from("ROUTING-SENTINEL").toString("base64") }]);
    const keys = currentEventOffsets(s.app.configDir);
    await s.press("a", { modifiers: ["command"] });
    const offsets = currentEventOffsets(s.app.configDir);
    await s.press("c", { modifiers: ["command"] });
    const copied = pasteboardText();
    const input = await s.get("core.surface.input", probe.surface);
    // A failure states the injection record of each phase of cmd+a and cmd+c: the first responder, whether the key waited
    // behind the held input of the window, whether it was taken as a key equivalent and whether it typed a stated text.
    const keyEvents = await traceEvents(s, keys);
    const records = JSON.stringify(["a", "c"].flatMap((key) => injectedKeyEvents(keyEvents, key)
      .map((event) => JSON.parse(event.fields.text))));
    assert.equal(copied, field.value, `native cmd+c did not copy the selected field text; key records ${records}`);
    assertNoViewKeydown(input, before.at(-1)?.sequence ?? 0, `native cmd+a/c (key records ${records})`);
    assert.equal((await traceEvents(s, offsets)).filter((event) => event.event === REGISTRY_COMMAND).length, 0,
      "native cmd+c must not run a page command");
  });

  test(`${app.name}: native cmd+= runs the text-size menu command without view keydown`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    const probe = await focusedField(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === probe.surface));
    assert.ok(card, "the probe has no owning card");
    await s.until("core.text", (value) => value.scope.kind === "card" && value.scope.card === card.id,
      "the probe did not select its owning text-size scope");
    const before = await s.get("core.surface.input", probe.surface);
    const beforeScale = (await s.get("core.text")).cards[card.id];
    const offsets = currentEventOffsets(s.app.configDir);
    await s.press("=", { modifiers: ["command"] });
    await s.until("core.text", (value) => value.cards[card.id] > beforeScale,
      "native cmd+= did not run the text-larger menu command");
    assertNoViewKeydown(await s.get("core.surface.input", probe.surface), before.at(-1)?.sequence ?? 0,
      "native cmd+=");
    assert.equal(await commandRuns(s, offsets, "core.text.larger"), 1,
      "native cmd+= must run core.text.larger exactly once");
  });

  for (const [page, name] of [["projects", "core.library.search"], ["plugins", "core.library.plugins.search"]]) {
    test(`${app.name}: cmd+k focuses ${page} search in the shown library`, { timeout: 60000 }, async (t) => {
      const s = await openProbe(t, app);
      if (page === "projects") await s.run("core.projects.browse");
      else await s.run("core.plugins.browse");
      await s.until("core.screen", (state) => state.screen === "library",
        `the ${page} library screen did not open`);
      await s.until("core.library", (state) => state.page === page,
        `the library did not select its ${page} page`);
      // A pointer move that presses nothing makes the window the virtual key window.
      const content = (await s.get("host.window")).content;
      await s.pointer(content.width / 2, content.height / 2, "move");
      await s.until("host.window", (window) => window.virtualKey, "the window did not become the virtual key window");
      await s.run("core.focus.set", { name: "core.library.window" });
      await s.until("core.focus", (focus) => focus?.name === "core.library.window" && focus.surface === null,
        `the ${page} library's new-window control did not hold main-document focus`);
      const mainWindow = await s.get("host.window");
      assert.equal(mainWindow.responder?.owner, "workbench",
        `the main document is not the responder before cmd+k: ${JSON.stringify(mainWindow.responder)}`);
      await s.press("k", { modifiers: ["command"] });
      await s.until("core.focus", (focus) => focus?.name === name && focus.surface === null,
        `cmd+k did not focus ${name}`);
      assert.equal((await s.get("host.window")).responder?.owner, "workbench",
        "cmd+k moved keyboard focus away from the main document");
      assert.equal((await s.get("core.screen")).screen, "library",
        "cmd+k changed the shown library screen");
    });
  }

  test(`${app.name}: a focused view keeps cmd+k when the library is hidden`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    const { surface } = await focusedField(s);
    assert.equal((await s.get("core.screen")).screen, "workspace",
      "the focused view key case requires the library to be hidden");
    const focusedWindow = await s.get("host.window");
    assert.equal(focusedWindow.virtualKey, true, "the focused view window is not the virtual key window");
    assert.equal(focusedWindow.responder?.surface, surface,
      `the probe view does not own the key responder: ${JSON.stringify(focusedWindow.responder)}`);
    const offsets = currentEventOffsets(s.app.configDir);
    await s.press("k", { modifiers: ["command"] });
    const events = await traceEvents(s, offsets);
    assertDeliveredKey(events, "k", "focused view cmd+k", { downResponder: "SPDocumentView" });
    // The shortcut table applies cmd+k only while the library is shown. With the library hidden,
    // the focused view owns its normal key handling and does not forward the workbench command.
    assert.equal(traceCommands(events, "core.library.search.focus").length, 0,
      "hidden-library cmd+k must not invoke the library-only workbench command");
    assert.equal(events.filter((event) => event.event === "workbench.input.shortcut.failed"
      && event.fields?.plugin === "probeinput" && event.fields?.command === "core.library.search.focus").length, 0,
    "hidden-library cmd+k must not report a failed forwarded command");
    assert.equal((await s.get("core.screen")).screen, "workspace",
      "hidden-library cmd+k changed the workspace screen");
  });

  test(`${app.name}: native shift+cmd+n opens and cleans up a library window`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    await focusedDocument(s);
    const initialWindows = await s.get("host.windows");
    const initialIDs = new Set(initialWindows.map((window) => window.window));
    s.cleanup(async () => {
      const current = await s.get("host.windows");
      for (const window of current) if (!initialIDs.has(window.window)) await s.on(window.window).close();
    });
    const mainWindow = initialWindows.find((window) => window.window === s.window);
    assert.ok(mainWindow, `the original window ${s.window} is absent: ${JSON.stringify(initialWindows)}`);

    let keyDown = false;
    try {
      keyDown = true;
      await s.key("n", "down", { modifiers: ["shift", "command"] });
      const windows = await s.windows(initialWindows.length + 1,
        "native shift+cmd+n did not create its new library window");
      const childWindow = windows.find((window) => !initialIDs.has(window.window));
      assert.ok(childWindow, "the new library window has no distinct native window identity");
      const child = s.on(childWindow.window);
      await child.until("core.screen", (value) => value.screen === "library",
        "native shift+cmd+n did not open the library screen");
      await child.key("n", "up", { modifiers: ["shift", "command"] });
      keyDown = false;
    } finally {
      if (keyDown) {
        const current = await s.get("host.windows");
        const child = current.find((window) => !initialIDs.has(window.window) && window.key);
        await (child ? s.on(child.window) : s).key("n", "up", { modifiers: ["shift", "command"] });
      }
    }
  });
}
