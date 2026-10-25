import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { readEventLines } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";

const STOP_REASON = "the view failed 4 times within 300 seconds and is created again when its tab is reopened";
const viewProcess = (host, surface) => host.documents.find((entry) =>
  entry.surface === surface && entry.document === "")?.process;

async function ready(s, surface, url) {
  await s.until("core.surfaces", (items) => items.some((item) => item.surface === surface
    && item.exposes.includes("status browser.location") && item.exposes.includes("command browser.reload")), "the restarted browser did not register its location");
  const location = await s.until("browser.location", (value) => value.url === url && value.title === "restart-state"
    && !value.loading && value.error === null, "the restarted browser did not restore its saved address", { surface });
  await s.until("host.window", (value) => ["", "page"].every((name) => value.documents.some((entry) =>
    entry.surface === surface && entry.document === name && entry.visible
      && entry.frame.width > 0 && entry.frame.height > 0)),
  "the restarted view or its document region is not visibly placed");
  return location;
}

async function stopRecording(s, recording) {
  const { displayed } = await s.presented();
  const result = await recording.stop({ after: displayed });
  assert.equal(result.limited, false, "the lifecycle recording reached its frame limit");
  const files = frames(result.frames);
  assert.ok(files.length > 0, "the lifecycle recording contains no frames");
  assert.equal(files.length, result.count, "the lifecycle recording omitted frame files");
  const measured = [];
  for (const file of files) {
    const frame = readFrame(file);
    measured.push({ time: frame.time, width: frame.width, height: frame.height });
  }
  return { frames: result.frames, samples: measured };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a view restores state, stops after four failures and reopens after unload`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { settings: { memorySaver: true, memorySaverDelay: 720 } });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end("<!doctype html><title>restart-state</title><p>Stored view restart state</p>");
    });
    server.on("error", (error) => { throw error; });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    s.cleanup(() => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }));
    const grid = await s.get("core.grid");
    const card = grid.cards.find((entry) => entry.tabs.some((tab) => tab.plugin === "browser"));
    assert.ok(card, "the fixture has no browser card");
    const surface = card.tabs.find((tab) => tab.plugin === "browser").id;
    const closeTarget = async () => {
      const current = await s.get("core.grid");
      if (current.cards.some((entry) => entry.tabs.some((tab) => tab.id === surface))) {
        assert.equal((await s.run("core.tab.close", { tab: surface })).closed, true,
          "the fault target remained open after the check");
      }
      await s.run("core.projects.flush");
    };
    s.cleanup(closeTarget);
    await s.run("core.tab.select", { tab: surface });
    const url = `http://127.0.0.1:${server.address().port}/restart-state`;
    await s.run("browser.navigate", { url }, surface);
    await ready(s, surface, url);
    await s.run("core.projects.flush");
    const stored = JSON.parse(readFileSync(join(app.configDir, "tab-state.json"), "utf8"));
    assert.equal(stored.format, 1, "tab-state.json has an unsupported format");
    assert.ok(stored.tabs[surface]?.state, "the browser persisted no tab state before the fault");

    const directory = join(app.configDir, "logs", "view-restart");
    mkdirSync(directory, { recursive: true });
    const evidence = { surface, url, phases: [] };
    const persist = () => writeFileSync(join(directory, `${process.pid}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    const escapedSurface = RegExp.escape(surface), escapedReason = RegExp.escape(STOP_REASON);
    const processError = new RegExp(`^error host view channel: ${escapedSurface}: the view process ended$`);
    const nativeError = /^error native document view: web content process terminated: soksak:\/\/browser\/ui\/index\.html$/;
    const stopError = new RegExp(`^error host view channel: ${escapedSurface}: ${escapedReason}$`);
    const displayError = new RegExp(`^error page surface status ${RegExp.escape(card.id)} ${escapedSurface}: 표면 오류 · ${escapedReason}$`);
    for (const pattern of [processError, nativeError, stopError, displayError]) s.expectError(pattern);
    const began = performance.now();
    for (let failure = 1; failure <= 4; failure++) {
      const host = await s.get("host.window");
      const previous = viewProcess(host, surface);
      assert.ok(Number.isSafeInteger(previous) && previous > 0 && previous !== host.pageProcess,
        `the exposed view PID ${previous} is invalid or belongs to the main page`);
      const recording = await s.record();
      const phase = { failure, previous, started: performance.now() - began };
      evidence.phases.push(phase);
      persist();
      process.kill(previous, "SIGKILL");
      if (failure < 4) {
        const changed = await s.until("host.window", (value) => {
          const pid = viewProcess(value, surface);
          return Number.isSafeInteger(pid) && pid > 0 && pid !== previous;
        }, "the ended view did not receive a replacement process");
        phase.replacement = viewProcess(changed, surface);
        await ready(s, surface, url);
        await s.run("browser.reload", {}, surface);
        await ready(s, surface, url);
      } else {
        await s.until("core.surfaces", (items) => items.some((item) => item.surface === surface
          && item.status.phase === "error" && item.status.error === STOP_REASON),
        "the fourth view failure did not show its stop reason");
        const stopped = await s.get("host.window");
        assert.ok(!viewProcess(stopped, surface), "the stopped view still has a live document process");
      }
      phase.recording = await stopRecording(s, recording);
      phase.ended = performance.now() - began;
      persist();
    }
    assert.ok(performance.now() - began < 300000, "the four failures fell outside the restart window");
    const reopening = await s.record();
    const { tab: other } = await s.run("core.card.add-tab", { card: card.id, plugin: "browser" });
    await s.until("core.grid", (value) => value.cards.some((entry) => entry.id === card.id && entry.active === other),
      "the stopped tab did not become hidden");
    await s.run("core.tab.unload", { tab: surface });
    await s.until("core.tab.memory", (value) => value.tabs.some((entry) => entry.tab === surface && entry.state === "unloaded"),
      "the stopped tab did not unload");
    await s.run("core.tab.select", { tab: surface });
    await ready(s, surface, url);
    const restored = await s.until("core.surfaces", (items) => items.some((item) => item.surface === surface
      && item.visible && item.status.phase === "ready" && item.status.error === null),
    "the reopened tab kept its stopped error");
    assert.equal(restored.find((item) => item.surface === surface).state, "loaded");
    evidence.reopened = await stopRecording(s, reopening);
    persist();
    await closeTarget();
    const after = JSON.parse(readFileSync(join(app.configDir, "tab-state.json"), "utf8"));
    assert.equal(Object.hasOwn(after.tabs, surface), false, "the removed fault target retained its saved state");
    await s.flushLog();
    const { lines } = readEventLines(app.configDir, s.eventStart);
    for (const [pattern, count] of [[processError, 4], [nativeError, 4], [stopError, 1], [displayError, 1]]) {
      assert.equal(lines.filter((line) => pattern.test(line)).length, count,
        `the deliberate fault produced an unexpected count for ${pattern}`);
    }
    t.diagnostic(`view restart evidence ${join(directory, `${process.pid}.json`)}`);
  });
}
