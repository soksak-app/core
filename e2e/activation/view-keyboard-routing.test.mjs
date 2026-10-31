// Activation-tier probes of native-menu, modal, and IME key routing from a focused plugin view.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { currentEventOffsets, readEvents, untilEventLines } from "@soksak/window-check/event-log.mjs";
import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { pasteboardText, writePasteboard } from "@soksak/window-check/pasteboard.mjs";
import { fresh, reading } from "../fixture.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";
import { compareAppKitReference } from "./ime-reference-steps.mjs";

const KOREAN_2SET = "com.apple.inputmethod.Korean.2SetKorean";
const REGISTRY_COMMAND = "page.command";
const MODAL_ANSWER = "page.trace.modal.answer";
const PICKER_CLOSE = "page.trace.picker.close";
const INPUT_INJECTION = "native.record.info";
const READS = [REGISTRY_COMMAND, MODAL_ANSWER, PICKER_CLOSE, "page.input.shortcut.failed", INPUT_INJECTION,
  "native.input.key_down"];

async function openProbe(t, app) {
  const s = await open(t, app);
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

function assertNoViewKeydown(events, after, label) {
  const forwarded = events.filter((event) => event.sequence > after && event.type === "keydown");
  assert.deepEqual(forwarded, [], `${label}: native input reached the plugin view: ${JSON.stringify(forwarded)}`);
}

async function focusedTerminal(s) {
  const [terminal] = await ensureTerminals(s, 1);
  const surface = terminal.surface;
  await s.keepPointerOutside();
  const view = await s.rect("terminal.view", undefined, surface);
  const point = { x: view.document.x + view.x + view.width / 2,
    y: view.document.y + view.y + view.height / 2 };
  await s.pointer(point.x, point.y, "move", { activate: true });
  await s.click(point.x, point.y);
  await s.until("host.window", (window) => window.active && window.key && window.responder?.surface === surface,
    "the terminal view did not become the active first-responder owner");
  return { terminal, surface };
}

async function focusedBrowser(s) {
  const browser = (await s.get("core.surfaces")).find((surface) => surface.plugin === "browser" && surface.visible);
  assert.ok(browser, "the fixture has no visible browser view");
  await s.until("core.surfaces", (all) => all.some((surface) => surface.surface === browser.surface
    && surface.exposes.includes("status browser.address.text") && surface.exposes.includes("dom browser.address")),
  "the browser did not register its address field");
  const url = await serveAddressPage(s);
  await s.run("browser.navigate", { url }, browser.surface);
  await s.until("browser.location", (location) => location.url === url && !location.loading && location.error === null,
    "the local address fixture did not load", { surface: browser.surface });
  await s.keepPointerOutside();
  const field = await s.rect("browser.address", undefined, browser.surface);
  await s.pointer(field.x + field.width / 2, field.y + field.height / 2, "move", { activate: true });
  await s.until("host.window", (window) => window.active && window.key,
    "the browser window did not become the active key window");
  await s.click(field.x + field.width / 2, field.y + field.height / 2);
  await s.until("host.window", (window) => window.responder?.surface === browser.surface,
    "the browser view did not become the first-responder owner");
  await s.until("browser.address.text", (value) => value.focused && value.value === url,
    "the browser address field did not report the focused local navigation address", { surface: browser.surface });
  return { ...browser, routingURL: url };
}

async function serveAddressPage(s) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>keyboard routing</title>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  s.cleanup(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}/routing-sentinel`;
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

for (const app of Object.values(APPS)) {
  test(`${app.name}: focused view closes its page picker once on Escape`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    const { surface } = await focusedTerminal(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    assert.ok(card, "the terminal has no owning card");

    let held = false;
    try {
      await s.request("diagnostics.modal.hold", { on: true });
      held = true;
      await s.run("core.card.menu", { card: card.id, menu: "add" });
      await s.until("core.picker", (picker) => picker.open, "the held page picker did not open");
      await s.request("diagnostics.modal.held");
      const heldWindow = await s.get("host.window");
      assert.equal(heldWindow.responder?.surface, surface,
        `the held transient picker did not leave the terminal view focused: ${JSON.stringify(heldWindow.responder)}`);
      const offsets = currentEventOffsets(s.app.configDir);
      await s.press("Escape");
      await s.until("core.picker", (picker) => !picker.open, "view Escape did not close the held page picker");
      const events = await traceEvents(s, offsets);
      assertDeliveredKey(events, "Escape", "focused terminal page-picker Escape", { downResponder: "SPImageRegion" });
      const closeCommands = traceCommands(events, "core.picker.close");
      assert.equal(closeCommands.length, 1,
        "view Escape must run core.picker.close exactly once");
      assert.equal(closeCommands[0].fields.ok, true, "the page picker close command did not succeed");
      assert.equal(events.filter((event) => event.event === PICKER_CLOSE
        && event.fields?.reason === "command").length, 1,
      "the held page picker must close once with reason command");
    } finally {
      try {
        if (held) await s.request("diagnostics.modal.hold", { on: false });
      } finally {
        if ((await s.get("core.picker")).open) await s.run("core.picker.close");
      }
    }
  });

  test(`${app.name}: native picker Escape dismisses its modal once`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    const { surface } = await focusedTerminal(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface));
    assert.ok(card, "the terminal has no owning card");
    await s.run("core.card.menu", { card: card.id, menu: "add" });
    await s.until("host.window", (window) => window.modal?.id === "picker" && window.modal.shown,
      "the native picker did not become visible");
    await s.until("core.modal", (modal) => modal?.id === "picker" && modal.document !== null,
      "the native picker document did not render");
    const nativePicker = await s.get("host.window");
    assert.equal(nativePicker.responder?.owner, "modal",
      `the ordinary picker does not own keyboard focus: ${JSON.stringify(nativePicker.responder)}`);
    const offsets = currentEventOffsets(s.app.configDir);
    await s.press("Escape");
    await s.until("core.picker", (picker) => !picker.open, "native picker Escape did not close the picker");
    const events = await traceEvents(s, offsets);
    assertDeliveredKey(events, "Escape", "native picker Escape");
    assert.equal(traceCommands(events, "core.picker.close").length, 0,
      "native picker Escape must not run the view's core.picker.close command");
    assert.equal(traceCommands(events, "core.modal.dismiss").length, 1,
      "native picker Escape must answer core.modal.dismiss once");
    assert.equal(events.filter((event) => event.event === MODAL_ANSWER
      && event.fields?.key === "core.modal.dismiss").length, 1,
    "the native picker must answer Escape once");
    assert.equal(events.filter((event) => event.event === PICKER_CLOSE
      && event.fields?.reason === "dismiss").length, 1,
    "the native picker must close once with reason dismiss");
  });

  test(`${app.name}: settings dialog Escape stays with the native modal responder`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    await focusedTerminal(s);
    await s.run("core.settings.open");
    await s.until("host.window", (window) => window.modal?.id === "settings" && window.modal.shown,
      "the settings dialog did not become visible");
    const modalWindow = await s.get("host.window");
    assert.equal(modalWindow.responder?.owner, "modal",
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
    const after = await s.get("host.window");
    assert.equal(after.modal?.id, "settings", "Escape closed the native settings dialog");
    assert.equal(after.responder?.owner, "modal", "Escape moved focus away from the settings dialog");
    assertDeliveredKey(events, "Escape", "settings dialog Escape");
    assert.equal(traceCommands(events, "core.picker.close").length, 0,
      "settings dialog Escape must not run a page picker command");
  });

  test(`${app.name}: native cmd+c copies selected address text without view keydown`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    const browser = await focusedBrowser(s);
    const address = await s.get("browser.address.text", browser.surface);
    assert.equal(address.value, browser.routingURL,
      "the address field does not contain the declared local navigation fixture");
    const before = await s.get("core.surface.input", browser.surface);
    writePasteboard([{ "public.utf8-plain-text": Buffer.from("ROUTING-SENTINEL").toString("base64") }]);
    await s.press("a", { modifiers: ["command"] });
    const offsets = currentEventOffsets(s.app.configDir);
    await s.press("c", { modifiers: ["command"] });
    assert.equal(pasteboardText(), address.value, "native cmd+c did not copy the selected address text");
    assertNoViewKeydown(await s.get("core.surface.input", browser.surface), before.at(-1)?.sequence ?? 0,
      "native cmd+a/c");
    assert.equal((await traceEvents(s, offsets)).filter((event) => event.event === REGISTRY_COMMAND).length, 0,
      "native cmd+c must not run a page command");
  });

  test(`${app.name}: native cmd+= runs the text-size menu command without view keydown`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    const browser = await focusedBrowser(s);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === browser.surface));
    assert.ok(card, "the browser has no owning card");
    await s.until("core.text", (value) => value.scope.kind === "card" && value.scope.card === card.id,
      "the browser did not select its owning text-size scope");
    const before = await s.get("core.surface.input", browser.surface);
    const beforeScale = (await s.get("core.text")).cards[card.id];
    const offsets = currentEventOffsets(s.app.configDir);
    await s.press("=", { modifiers: ["command"] });
    await s.until("core.text", (value) => value.cards[card.id] > beforeScale,
      "native cmd+= did not run the text-larger menu command");
    assertNoViewKeydown(await s.get("core.surface.input", browser.surface), before.at(-1)?.sequence ?? 0,
      "native cmd+=");
    assert.equal(traceCommands(await traceEvents(s, offsets), "core.text.larger").length, 1,
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
      await s.run("core.focus.set", { name: "core.library.window" });
      await s.until("core.focus", (focus) => focus?.name === "core.library.window" && focus.surface === null,
        `the ${page} library's new-window control did not hold main-document focus`);
      const mainWindow = await s.get("host.window");
      assert.equal(mainWindow.responder?.owner, "page",
        `the main document is not the responder before cmd+k: ${JSON.stringify(mainWindow.responder)}`);
      await s.press("k", { modifiers: ["command"] });
      await s.until("core.focus", (focus) => focus?.name === name && focus.surface === null,
        `cmd+k did not focus ${name}`);
      assert.equal((await s.get("host.window")).responder?.owner, "page",
        "cmd+k moved keyboard focus away from the main document");
      assert.equal((await s.get("core.screen")).screen, "library",
        "cmd+k changed the shown library screen");
    });
  }

  test(`${app.name}: focused browser keeps cmd+k when the library is hidden`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    const { surface } = await focusedBrowser(s);
    assert.equal((await s.get("core.screen")).screen, "workspace",
      "the focused browser key case requires the library to be hidden");
    const focusedWindow = await s.get("host.window");
    assert.equal(focusedWindow.active, true, "the focused browser window is not active");
    assert.equal(focusedWindow.key, true, "the focused browser window is not the key window");
    assert.equal(focusedWindow.responder?.surface, surface,
      `the browser view does not own the key responder: ${JSON.stringify(focusedWindow.responder)}`);
    const offsets = currentEventOffsets(s.app.configDir);
    await s.press("k", { modifiers: ["command"] });
    const events = await traceEvents(s, offsets);
    assertDeliveredKey(events, "k", "focused browser cmd+k", { downResponder: "SPDocumentView" });
    // The shortcut table applies cmd+k only while the library is shown. With the library hidden,
    // the focused view owns its normal key handling and does not forward the workbench command.
    assert.equal(traceCommands(events, "core.library.search.focus").length, 0,
      "hidden-library cmd+k must not invoke the library-only workbench command");
    assert.equal(events.filter((event) => event.event === "page.input.shortcut.failed"
      && event.fields?.plugin === "browser" && event.fields?.command === "core.library.search.focus").length, 0,
    "hidden-library cmd+k must not report a failed forwarded command");
    assert.equal((await s.get("core.screen")).screen, "workspace",
      "hidden-library cmd+k changed the workspace screen");
  });

  test(`${app.name}: native shift+cmd+n opens and cleans up a library window`, { timeout: 60000 }, async (t) => {
    const s = await openProbe(t, app);
    await focusedTerminal(s);
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

  test(`${app.name}: IME Escape ends view composition as it does in AppKit`, { timeout: 90000 }, async (t) => {
    const s = await openProbe(t, app);
    const { surface } = await focusedTerminal(s);
    await s.selectInputSource(KOREAN_2SET);
    await compareAppKitReference(s, ["g", "k", "s", "Escape"], "한", ["ㅎ", "하", "한", "한"]);
    await focusedTerminal(s);
    const recording = await s.record();
    // The recording starts before the first key and remains active through the committed screen after Escape.
    for (const [key, expected] of [["g", "ㅎ"], ["k", "하"], ["s", "한"]]) {
      await s.press(key);
      await s.until("terminal.compose", (compose) => compose.text === expected,
        `the Korean input method did not produce ${expected}`, { surface });
    }
    const offsets = currentEventOffsets(s.app.configDir);
    await s.press("Escape");
    await s.until("terminal.compose", (compose) => compose.text === "",
      "Escape did not end the active composition", { surface });
    const linesAfter = await readScreenUntil(s, surface,
      (lines) => lines.some((line) => line.trimEnd().endsWith("한")),
      "Escape did not commit the AppKit reference text into the terminal document");
    assert.ok(linesAfter.some((line) => line.trimEnd().endsWith("한")),
      `the terminal document does not end in the committed AppKit text: ${JSON.stringify(linesAfter)}`);
    const gestureEnd = await s.presented();
    const stopped = await recording.stop({ after: gestureEnd.displayed + 100 });
    const captured = frames(recording.frames).map(readFrame);
    assert.equal(captured.length, stopped.count, "the IME Escape recording has missing frame files");
    assert.ok(captured.length > 1, "the IME Escape recording has no complete frames");
    assert.equal(stopped.limited, false, "the IME Escape recording exceeded its bounded capacity");
    const events = await traceEvents(s, offsets);
    assert.equal(traceCommands(events, "core.picker.close").length, 0,
      "composition Escape must not forward core.picker.close");
    assert.equal(events.filter((event) => event.event === "page.input.shortcut.failed").length, 0,
      "composition Escape must not forward a workbench shortcut command");
    assert.deepEqual((await s.get("core.page.audit")).unbound, []);
    t.diagnostic(`${app.name}: captured complete g/k/s/Escape gesture in ${captured.length} frames`);
  });
}
