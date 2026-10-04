// 터미널 표면의 입력이 터미널 사이드카를 거쳐 같은 표면의 출력으로 돌아오는지 검사한다.
// 창 크기가 바뀌어도 터미널 그림이 영역과 DOM 을 따라가는지 검사한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

// 애플리케이션 메뉴는 하나의 ko/en 표로 만들어지므로 검사도 메뉴 언어를 따라간다.
const MENU_TITLES = {
  ko: { menu: "보기", larger: "글자 크게" },
  en: { menu: "View", larger: "Bigger Text" },
};
const largerTitle = async (s) => MENU_TITLES[(await s.get("host.menu")).language] ?? MENU_TITLES.en;


import { APPS, drag, failure, fresh, open, within } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";
import { glyphShape, surfaceBoxes, whitePixels } from "./outside.mjs";
import { assertHeldStatesShown } from "./drag-measurement.mjs";
import { terminalProcessSnapshot } from "./terminal-processes.mjs";
import {
  cellBackgrounds, ensureTerminals, isColor, MEASURED_BACKGROUND, readScreenUntil, selectionBackground, setMeasuredBackground,
} from "./terminal-screen.mjs";

// 1x1 RGBA PNG 이미지.
const PNG = Buffer.from("89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082", "hex");


async function closeTerminalTabs(session) {
  const grid = await session.get("core.grid");
  for (const tab of grid.cards.flatMap((card) => card.tabs).filter((tab) => tab.plugin === "terminal")) {
    await session.run("core.tab.close", { tab: tab.id });
  }
}

async function terminalBackgroundSample(session, rect) {
  await session.request("diagnostics.capture.start", {});
  const displayed = await session.presented();
  const { frames: frameDir } = await session.request("diagnostics.capture.stop", { after: displayed.displayed });
  const files = frames(frameDir);
  assert.ok(files.length > 0, "terminal theme capture produced no frames");
  const frame = readFrame(files.at(-1));
  const x = Math.round(rect.x + rect.width * 0.75);
  const y = Math.round(rect.y + rect.height * 0.75);
  const sample = pixel(frame, x, y);
  rmSync(frameDir, { recursive: true, force: true });
  return sample;
}

async function terminalCursorCell(session, surface) {
  await session.presented();
  await session.request("diagnostics.capture.start", {});
  const displayed = await session.presented();
  const { frames: frameDir } = await session.request("diagnostics.capture.stop", { after: displayed.displayed });
  const files = frames(frameDir);
  assert.ok(files.length > 0, "cursor policy capture produced no frames");
  const frame = readFrame(files.at(-1));
  const host = await session.get("host.window");
  const region = host.regions.find((item) => item.surface === surface && item.name === "view");
  assert.ok(region?.frame, `native terminal region ${surface} has no frame`);
  const cursor = await session.get("terminal.cursor", surface);
  const state = await session.get("terminal.session", surface);
  const x0 = Math.max(0, Math.round((region.frame.x + cursor.col * state.cellWidth) * frame.scale));
  const y0 = Math.max(0, Math.round((region.frame.y + cursor.row * state.cellHeight) * frame.scale));
  const x1 = Math.min(frame.width, x0 + Math.ceil(state.cellWidth * frame.scale));
  const y1 = Math.min(frame.height, y0 + Math.ceil(state.cellHeight * frame.scale));
  const pixels = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixels.push(pixel(frame, x, y));
  const surfaceX = Math.max(0, Math.round(region.frame.x * frame.scale));
  const surfaceY = Math.max(0, Math.round(region.frame.y * frame.scale));
  const surfaceWidth = Math.min(frame.width - surfaceX, Math.ceil(region.frame.width * frame.scale));
  const surfaceHeight = Math.min(frame.height - surfaceY, Math.ceil(region.frame.height * frame.scale));
  const surfacePixels = [];
  for (let y = surfaceY; y < surfaceY + surfaceHeight; y++) {
    for (let x = surfaceX; x < surfaceX + surfaceWidth; x++) surfacePixels.push(pixel(frame, x, y));
  }
  rmSync(frameDir, { recursive: true, force: true });
  return { cell: pixels, surface: surfacePixels };
}

async function terminalFrame(session) {
  await session.request("diagnostics.capture.start", {});
  const displayed = await session.presented();
  const { frames: frameDir } = await session.request("diagnostics.capture.stop", { after: displayed.displayed });
  try {
    const files = frames(frameDir);
    assert.ok(files.length > 0, "terminal selection capture produced no frames");
    return readFrame(files.at(-1));
  } finally {
    rmSync(frameDir, { recursive: true, force: true });
  }
}

async function terminalColorBounds(session, surface, color) {
  const frame = await terminalFrame(session);
  const host = await session.get("host.window");
  const region = host.regions.find((item) => item.surface === surface && item.name === "view");
  assert.ok(region?.frame, `native terminal region ${surface} has no frame`);
  const scale = frame.scale;
  const x0 = Math.max(0, Math.round(region.frame.x * scale));
  const y0 = Math.max(0, Math.round(region.frame.y * scale));
  const x1 = Math.min(frame.width, Math.ceil((region.frame.x + region.frame.width) * scale));
  const y1 = Math.min(frame.height, Math.ceil((region.frame.y + region.frame.height) * scale));
  let count = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  // 실패하면 무엇이 그려졌는지 알 수 있도록 영역의 색을 센다.
  const histogram = new Map();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px = pixel(frame, x, y);
      const key = px.slice(0, 3).join(",");
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
      const matches = color === "red"
        ? px[0] >= 180 && px[1] <= 80 && px[2] <= 80
        : px[0] <= 80 && px[1] <= 80 && px[2] >= 180;
      if (matches) {
        count++;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const colors = [...histogram].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([rgb, n]) => `${rgb}×${n}`).join(" ");
  return { count, minY, maxY, measured: `region ${JSON.stringify(region.frame)} presented ${JSON.stringify(region.presented)}; colors ${colors}` };
}

function differentPixels(before, after) {
  return before.reduce((count, value, index) => count +
    (value.some((channel, channelIndex) => channel !== after[index]?.[channelIndex]) ? 1 : 0), 0);
}

async function assertGridFillsPlane(session, message) {
  const grid = await session.get("core.grid");
  assert.ok(grid?.plane, `${message}: grid has no plane measurement`);
  assert.equal(Math.round(grid.width), Math.round(grid.plane.w),
    `${message}: grid width ${grid.width} does not fill plane width ${grid.plane.w}`);
  assert.equal(Math.round(grid.height), Math.round(grid.plane.h),
    `${message}: grid height ${grid.height} does not fill plane height ${grid.plane.h}`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a newly split terminal presents its first native raster`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    t.diagnostic(`${app.name}: START split-terminal presentation`);
    const terminals = await ensureTerminals(s, 2);
    for (const terminal of terminals) {
      await s.until("terminal.session", (state) => Boolean(state.sessionId),
        `${terminal.surface} did not open a sidecar session`, { surface: terminal.surface });
    }
    const host = await s.get("host.window");
    for (const terminal of terminals) {
      const region = host.regions.find((item) => item.surface === terminal.surface && item.name === "view");
      assert.ok(region?.visible && region.presented,
        `${terminal.surface} was not visible and presented after splitting: ${JSON.stringify(region)}`);
    }
    t.diagnostic(`${app.name}: PASS split-terminal presentation`);
  });

  test(`${app.name}: four split terminals complete native presentation without a host crash`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    t.diagnostic(`${app.name}: START four-terminal presentation`);
    const terminals = await ensureTerminals(s, 4);
    for (const terminal of terminals) {
      await s.until("terminal.session", (state) => Boolean(state.sessionId),
        `${terminal.surface} did not open a sidecar session`, { surface: terminal.surface, timeout: 10000 });
    }
    const host = await s.get("host.window");
    const regions = host.regions.filter((region) => terminals.some((terminal) =>
      terminal.surface === region.surface && region.name === "view"));
    assert.equal(regions.length, 4, `four terminal native regions were not reported: ${JSON.stringify(regions)}`);
    assert.ok(regions.every((region) => region.visible && region.presented),
      `a four-terminal native region was not presented: ${JSON.stringify(regions)}`);
    t.diagnostic(`${app.name}: PASS four-terminal presentation`);
  });

  test(`${app.name}: endpoint split requests survive repeated native WebView presentation`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    t.diagnostic(`${app.name}: START endpoint repeated split`);
    const terminals = await ensureTerminals(s, 3);
    assert.equal(terminals.length, 3, "the endpoint must report all three split terminals");
    for (const terminal of terminals) {
      const session = await s.until("terminal.session", (state) => state.sessionId,
        `${terminal.surface} did not retain its session after repeated split`, { surface: terminal.surface });
      assert.ok(session.sessionId, `${terminal.surface} lost its session after split`);
    }
    const host = await s.get("host.window");
    const regions = host.regions.filter((region) => terminals.some((terminal) =>
      terminal.surface === region.surface && region.name === "view"));
    assert.equal(regions.length, 3, `endpoint split lost a native region: ${JSON.stringify(host)}`);
    assert.ok(regions.every((region) => region.visible && region.presented),
      `endpoint split left an unpresented region: ${JSON.stringify(regions)}`);
    t.diagnostic(`${app.name}: PASS endpoint repeated split`);
  });

  test(`${app.name}: native presentation failure is explicit and the next split remains usable`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    t.diagnostic(`${app.name}: START injected presentation failure`);
    await ensureTerminals(s, 1);
    await s.request("diagnostics.presentation.failure", {});
    await assert.rejects(
      () => s.presented(),
      (error) => /injected native presentation failure/.test(error.message),
      "an injected native presentation failure must not become a generic timeout",
    );
    const terminals = await ensureTerminals(s, 2);
    for (const terminal of terminals) {
      const region = (await s.get("host.window")).regions.find((item) =>
        item.surface === terminal.surface && item.name === "view");
      assert.ok(region?.visible && region.presented,
        `${terminal.surface} did not recover after the injected failure: ${JSON.stringify(region)}`);
    }
    t.diagnostic(`${app.name}: PASS injected presentation failure`);
  });

  test(`${app.name}: three terminals and two browsers share one app DOM and one terminal service`, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const initial = await s.get("core.grid");
    const tab = initial.cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
    assert.ok(tab, "the fixture must contain a terminal tab");
    await s.run("core.tab.select", { tab: tab.id });
    const terminals = await ensureTerminals(s, 3);
    const browser = (await s.get("core.grid")).cards.find((card) =>
      card.tabs.find((tab) => tab.id === card.active)?.plugin === "browser");
    assert.ok(browser, "the fixture must contain a visible browser card");
    await s.run("core.card.split", { card: browser.id, side: "right", plugin: "browser" });
    await s.until("core.surfaces", (surfaces) => surfaces.filter((item) =>
      item.visible && item.plugin === "browser").length === 2, "two browsers did not become visible");
    for (const terminal of terminals) {
      await s.until("terminal.session", (state) => Boolean(state.sessionId),
        `session ${terminal.surface} did not open`, { surface: terminal.surface });
    }
    await s.presented();
    const window = await s.get("host.window");
    assert.equal(window.appDomWebviews, 1, "all plugin DOM must share the window's single app WebView");
    assert.equal(window.documentWebviews, 2, "external browser documents must have independent native WebViews");
    const processes = terminalProcessSnapshot(app.configDir);
    if (processes.shells.length !== 3) {
      const sessions = [];
      for (const terminal of terminals) {
        sessions.push({ surface: terminal.surface, session: (await s.get("terminal.session", terminal.surface)).sessionId });
      }
      const ages = execFileSync("ps", ["-o", "pid=,etime=,command=", "-p", processes.shells.join(",")], { encoding: "utf8" }).trim();
      assert.fail(`three independent terminals must own three shells, found ${processes.shells.length}; ` +
        `fixture tab ${tab.id}; visible sessions ${JSON.stringify(sessions)}; shells (pid, age, command): ${JSON.stringify(ages.split("\n"))}`);
    }
    const sessions = await Promise.all(terminals.map(async ({ surface }) =>
      [surface, (await s.get("terminal.session", surface)).sessionId]));
    assert.equal(new Set(sessions.map(([, id]) => id)).size, 3, "terminals must not share a PTY session");
    const project = await s.get("core.project");
    for (let round = 0; round < 3; round++) {
      await s.run("core.projects.browse");
      await s.run("core.library.open", { id: project.id });
      const returned = await s.get("host.window");
      assert.equal(returned.appDomWebviews, 1, `return ${round} created an extra app WebView`);
      assert.equal(returned.documentWebviews, 2, `return ${round} duplicated or lost a browser document`);
      assert.deepEqual(terminalProcessSnapshot(app.configDir), processes,
        `return ${round} changed the service or shell processes`);
      for (const [surface, sessionId] of sessions) {
        assert.equal((await s.get("terminal.session", surface)).sessionId, sessionId,
          `return ${round} replaced terminal session ${surface}`);
        const region = returned.regions.find((region) => region.surface === surface);
        assert.ok(region?.visible && region.presented,
          `return ${round} failed to immediately restore terminal ${surface}`);
      }
    }
  });

  test(`${app.name}: closing terminal tabs reaps every PTY child without killing the shared service`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const grid = await s.get("core.grid");
    const tab = grid.cards.flatMap((card) => card.tabs).find((item) => item.plugin === "terminal");
    assert.ok(tab, "the fixture must contain a terminal tab");
    await s.run("core.tab.select", { tab: tab.id });
    const terminals = await ensureTerminals(s, 3);
    assert.equal(terminals.length, 3, "the close test requires three terminal sessions");
    await s.presented();

    const before = terminalProcessSnapshot(app.configDir);
    assert.equal(before.shells.length, 3, "three open terminal sessions must own three PTY children");

    const surfaces = terminals.map((terminal) => terminal.surface);
    const closing = await s.collect("host.sidecars");
    await closeTerminalTabs(s);
    await s.until(
      "core.surfaces",
      (current) => current.every((surface) => surface.plugin !== "terminal"),
      "terminal surfaces did not close",
    );
    // 서비스는 셸을 회수한 뒤에야 closed 에 답하고, 호스트는 답을 받을 때까지 그 표면을 host.sidecars 에 둔다
    // (docs/spec/sidecars.md#messages).
    await s.until("host.sidecars", (state) => !state.closing.some((entry) => surfaces.includes(entry.surface)),
      "the terminal service did not answer the closes");
    // 대기가 실제로 닫기 답을 기다렸음을 보인다. 각 터미널 표면은 닫는 동안 host.sidecars 에 있었다.
    const listed = new Set((await closing.stop()).flatMap((state) => state.closing.map((entry) => entry.surface)));
    assert.deepEqual(surfaces.filter((surface) => !listed.has(surface)), [],
      `terminal surfaces never awaited a close answer: ${JSON.stringify([...listed])}`);
    const after = terminalProcessSnapshot(app.configDir);
    assert.equal(after.service, before.service, "closing tabs must not recreate the shared terminal service");
    assert.deepEqual(after.shells, [], "normal terminal close must reap every PTY child before the close answer");
  });

  test(`${app.name}: padding settings inset the terminal grid and show the terminal background`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await setMeasuredBackground(s, surface);
    const padding = { top: 6, right: 10, bottom: 14, left: 18 };
    const set = (side, value) => s.run("core.settings.change", { key: `terminal.padding.${side}`, value, scope: "common" });
    s.cleanup(async () => {
      for (const side of Object.keys(padding)) await set(side, 0);
    });
    const before = await s.rect("terminal.view", undefined, surface);
    const { cols, rows } = await s.get("terminal.session", surface);
    for (const [side, value] of Object.entries(padding)) await set(side, value);
    // 격자는 padding 안쪽의 그림 영역에 맞춰 다시 정해진다.
    await s.until("terminal.session", (session) => session.cols < cols && session.rows < rows,
      "the terminal grid did not shrink inside the padding", { surface });
    const view = await s.rect("terminal.view", undefined, surface);
    const inset = { top: view.y - before.y, right: before.x + before.width - (view.x + view.width),
      bottom: before.y + before.height - (view.y + view.height), left: view.x - before.x };
    assert.deepEqual(inset, padding, `the view is not inset by the padding: ${JSON.stringify({ before, view })}`);
    // 네이티브 그림 영역은 안쪽 영역을 따른다.
    const frame = { x: view.document.x + view.x, y: view.document.y + view.y, width: view.width, height: view.height };
    await s.until("host.window", (window) => window.regions.some((region) => region.surface === surface &&
      Object.keys(frame).every((key) => Math.abs(region.frame[key] - frame[key]) <= 1)),
      `the image region did not follow the padded view ${JSON.stringify(frame)}`);
    // padding 자리는 터미널의 기본 배경색이다.
    await s.request("diagnostics.capture.start", {});
    const { displayed } = await s.presented();
    const { frames: dir } = await s.request("diagnostics.capture.stop", { after: displayed });
    try {
      const files = frames(dir);
      assert.ok(files.length > 0, "the padding capture produced no frames");
      const shot = readFrame(files.at(-1));
      const at = (x, y) => pixel(shot, Math.round(x * shot.scale), Math.round(y * shot.scale));
      const samples = {
        left: at(frame.x - padding.left / 2, frame.y + frame.height / 2),
        top: at(frame.x + frame.width / 2, frame.y - padding.top / 2),
      };
      t.diagnostic(`padding samples ${JSON.stringify(samples)}`);
      for (const [side, sample] of Object.entries(samples)) {
        assert.ok(sample.every((value, index) => Math.abs(value - MEASURED_BACKGROUND[index]) <= 8),
          `the ${side} padding does not show the terminal background: ${sample}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${app.name}: removing a project ends the terminal sessions that its layout held`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    await readScreenUntil(s, terminal.surface, (lines) => lines.some((line) => line.includes("$")), "shell prompt missing");
    const held = terminalProcessSnapshot(app.configDir).shells;
    assert.ok(held.length > 0, "the first project has no terminal shell");

    // 같은 창에서 다른 프로젝트를 열면 첫 프로젝트의 세션은 보존된다.
    s.cleanup(() => s.run("core.settings.set", { patch: { projectOpening: "windows" }, scope: "common" }));
    await s.run("core.settings.set", { patch: { projectOpening: "tabs" }, scope: "common" });
    const other = mkdtempSync(join(tmpdir(), "soksak-retain-"));
    s.cleanup(() => rmSync(other, { recursive: true, force: true }));
    await s.run("core.project.open", { root: other, color: "#7fe3b0" });
    await s.until("core.project", (project) => project?.root === realpathSync(other), "the second project did not open in the window");
    const preserved = terminalProcessSnapshot(app.configDir).shells;
    assert.ok(held.every((pid) => preserved.includes(pid)), `opening another project ended the first project's shells: ${held} -> ${preserved}`);

    // fixture 는 두 프로젝트를 지운다. 지운 레이아웃의 탭은 다시 붙을 곳이 없으므로 그 세션은 끝난다.
    await s.request("diagnostics.fixture");
    const after = terminalProcessSnapshot(app.configDir).shells;
    const left = held.filter((pid) => after.includes(pid));
    assert.deepEqual(left, [], `the removed project's shells remain: ${left} (before ${held}, after ${after})`);
  });

  test(`${app.name}: a click gives native focus to the clicked terminal and its card`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const terminals = await ensureTerminals(s, 3);
    await s.presented();
    // 누른 카드의 포커스와 네이티브 키보드 포커스는 같은 터미널을 가리켜야 한다(V5-46).
    for (const terminal of [...terminals, terminals[0]]) {
      const view = await s.rect("terminal.view", undefined, terminal.surface);
      await s.click(view.document.x + view.x + view.width / 2, view.document.y + view.y + view.height / 2);
      await s.until("core.grid", (grid) => grid.cards.some((card) => card.focused &&
        card.tabs.some((tab) => tab.id === terminal.surface)), `the card of ${terminal.surface} did not take focus`);
      const host = await s.until("host.window", (window) => window.responder?.surface === terminal.surface,
        `${terminal.surface} did not become the native first responder after its click`);
      assert.deepEqual(host.regions.filter((region) => region.focused).map((region) => region.surface), [terminal.surface]);
    }
  });

  test(`${app.name}: the login shell setting starts the account's login shell as a login shell`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => closeTerminalTabs(s));
    const existing = await ensureTerminals(s, 1);
    await s.run("core.settings.change", { key: "terminal.shell", value: "login", scope: "common" });
    // 설정은 그 뒤에 여는 세션에 적용된다. 새 터미널을 연다.
    const terminals = await ensureTerminals(s, existing.length + 1);
    const opened = terminals.find((terminal) => !existing.some((item) => item.surface === terminal.surface));
    assert.ok(opened, "no new terminal opened after the setting changed");
    const expected = `-${basename(userInfo().shell)}`;
    await s.run("terminal.input", { bytes: "printf 'ARGV0=%s\\n' \"$0\"\r" }, opened.surface);
    await readScreenUntil(s, opened.surface, (lines) => lines.some((line) => line.trim() === `ARGV0=${expected}`),
      `the new terminal did not start ${userInfo().shell} as a login shell (argv0 ${expected})`);
  });

  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    test(`${app.name}: a resize redraws a wrapped ${basename(shell)} input line without rows of the previous width`, async (t) => {
      const s = await open(t, app);
      if (!s) return t.skip(`${app.binary} is not built`);
      await fresh(s);
      s.cleanup(() => closeTerminalTabs(s));
      const existing = await ensureTerminals(s, 1);
      await s.run("core.settings.change", { key: "terminal.shell", value: shell, scope: "common" });
      const terminals = await ensureTerminals(s, existing.length + 1);
      const opened = terminals.find((terminal) => !existing.some((item) => item.surface === terminal.surface));
      assert.ok(opened, "no new terminal opened after the setting changed");
      // 셸 통합이 첫 프롬프트를 알려야 크기 변경에서 프롬프트 행을 지운다.
      await s.until("terminal.session", (session) => session.vendor?.shell?.marker === "prompt.start",
        `${shell} did not report an OSC 133 prompt start`, { surface: opened.surface });
      const { cols } = await s.get("terminal.session", opened.surface);
      // 화면 상태의 행은 끝의 기본 칸을 생략하므로 열 수까지 채운다. 출력 행 뒤의 행을 이어 붙이면 프롬프트의 논리적 행이다.
      const rowsOf = (lines, width) => lines.map((row) => row.map((cell) =>
        cell.ch === undefined ? " ".repeat(cell.width) : cell.ch).join("").padEnd(width, " "));
      // 프롬프트 바로 위의 출력 행도 크기 변경 뒤 그대로 있어야 한다. 셸이 올라가는 행 수가 틀리면 이 행을 덮어쓴다.
      const above = "ABOVE-LINE";
      await s.run("terminal.input", { bytes: `printf '${above}\\n'\r` }, opened.surface);
      await s.until("terminal.screen", (lines) => {
        const rows = rowsOf(lines, cols);
        const index = rows.lastIndexOf(above.padEnd(cols, " "));
        return index >= 0 && rows[index + 1]?.trim().length > 0;
      }, `${shell} did not show a prompt after the output line`, { surface: opened.surface });
      // 입력은 실행하지 않고 두 행 가까이 차지하게 한다. 공백은 앞에만 있어 행 경계에 걸리지 않는다.
      const input = `true START-${"x".repeat(Math.max(20, cols - 20))}-END`;
      await s.run("terminal.input", { bytes: input }, opened.surface);
      const promptLine = (rows, width) => {
        const index = rows.lastIndexOf(above.padEnd(width, " "));
        return index < 0 ? null : { row: index + 1, text: rows.slice(index + 1).join("") };
      };
      // 좁아지는 재배치는 커서 행을 두고 그 위의 행을 기록으로 올린다(프로젝트 폴더 경로의 프롬프트는 좁은 폭에서
      // 여러 행이다). 출력 행과 프롬프트의 순서는 기록과 화면을 이어서 읽는다. 기록은 선언된 명령으로 뷰포트를
      // 옮겨 읽고 다시 최신 출력으로 돌아온다.
      const history = async (width) => {
        const { scrollback, rows } = await s.get("terminal.session", opened.surface);
        if (scrollback.history === 0) return [];
        assert.ok(scrollback.history <= rows, `${scrollback.history} history rows do not fit one screen of ${rows} rows`);
        await s.run("terminal.scrollback.set", { offset: scrollback.history }, opened.surface);
        await s.until("terminal.session", (value) => value.scrollback.offset === scrollback.history,
          "the viewport did not move to the oldest history row", { surface: opened.surface });
        const earlier = rowsOf(await s.get("terminal.screen", opened.surface), width).slice(0, scrollback.history);
        await s.run("terminal.scrollback.set", { offset: 0 }, opened.surface);
        await s.until("terminal.session", (value) => value.scrollback.offset === 0,
          "the viewport did not return to the newest output", { surface: opened.surface });
        return earlier;
      };
      // 출력 행 바로 다음 행에서 프롬프트와 입력이 한 번만 이어지고, 커서가 입력의 끝에 있어야 한다.
      const consistent = async (width, label, prompt) => {
        let measured = "";
        // 셸이 다시 그리면 화면에 입력이 한 번 나온다. 그리기 전에는 엔진이 프롬프트 행을 지워 없다.
        try {
          await s.until("terminal.screen", (lines) => {
            const rows = rowsOf(lines, width);
            const count = rows.join("").split("START-").length - 1;
            measured = `START- ${count} times in ${JSON.stringify(rows.join("").trimEnd())}`;
            return count === 1 && rows.join("").includes(input);
          }, `${label}: the screen did not show the input once`, { surface: opened.surface });
        } catch (error) {
          const { vendor } = await s.get("terminal.session", opened.surface);
          throw new Error(`${label}: the input is not shown once: ${measured}; last shell mark ${JSON.stringify(vendor?.shell)}`);
        }
        const earlier = await history(width);
        const current = rowsOf(await s.get("terminal.screen", opened.surface), width);
        const all = [...earlier, ...current];
        const line = promptLine(all, width);
        const count = all.join("").split("START-").length - 1;
        const starts = line && (prompt === undefined ? line.text.indexOf(input) > 0 : line.text.startsWith(prompt + input));
        assert.ok(count === 1 && starts, `${label}: the prompt line does not follow ${above} once: START- ${count} times in ` +
          `${JSON.stringify(all.map((row) => row.trimEnd()))} (${earlier.length} history rows)`);
        // 커서는 화면에서 입력의 끝 바로 뒤에 있다.
        const end = current.join("").indexOf(input) + input.length;
        await s.until("terminal.cursor",
          (value) => value.row === Math.floor(end / width) && value.col === end % width,
          `${label}: the cursor is not after the input end at row ${Math.floor(end / width)} col ${end % width} ` +
            `in ${JSON.stringify(current.map((row) => row.trimEnd()))}`,
          { surface: opened.surface });
        return line.text.slice(0, line.text.indexOf(input));
      };
      const prompt = await consistent(cols, "before the resize");
      const grid = await s.get("core.grid");
      const card = grid.cards.find((item) => item.active === opened.surface);
      assert.ok(card && card.c0 > 0, "the new terminal card has no left boundary");
      const start = grid.lines.x[card.c0];
      await s.run("core.boundary.move", { axis: "x", line: card.c0, position: start + Math.round(card.w / 2) });
      const narrow = (await s.until("terminal.session", (session) => session.cols < cols,
        "the terminal did not narrow", { surface: opened.surface })).cols;
      await consistent(narrow, `after narrowing to ${narrow} columns`, prompt);
      await s.run("core.boundary.move", { axis: "x", line: card.c0, position: start });
      await s.until("terminal.session", (session) => session.cols === cols,
        "the terminal did not return to its width", { surface: opened.surface });
      await consistent(cols, `after widening to ${cols} columns`, prompt);
      // 경계를 끌면 셸이 다시 그리는 사이에도 크기가 연달아 바뀐다.
      await drag(t, s, { axis: "x", line: card.c0, dx: Math.round(card.w / 2), dy: 0, ms: 96, times: 1 });
      await s.until("terminal.session", (session) => session.cols === cols,
        "the terminal did not return to its width after the drag", { surface: opened.surface });
      await consistent(cols, `after a divider drag`, prompt);
    });
  }

  test(`${app.name}: the terminal tab shows the program title unless the title setting is name`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => closeTerminalTabs(s));
    const [terminal] = await ensureTerminals(s, 1);
    const label = (grid) => grid.cards.flatMap((card) => card.tabs).find((tab) => tab.id === terminal.surface)?.label;
    await s.run("terminal.input", { bytes: "printf '\\033]2;TITLE-CHECK\\007'\r" }, terminal.surface);
    await s.until("core.grid", (grid) => label(grid) === "TITLE-CHECK",
      "the tab did not show the program title", { timeout: 10000 });
    await s.run("core.settings.change", { key: "terminal.title", value: "name", scope: "common" });
    await s.until("core.grid", (grid) => label(grid) === null, "the name setting kept the program title");
    await s.run("core.settings.change", { key: "terminal.title", value: "program", scope: "common" });
    await s.until("core.grid", (grid) => label(grid) === "TITLE-CHECK", "the program setting did not show the last title");
    // 제목 초기화(빈 제목)는 탭 이름으로 돌아간다.
    await s.run("terminal.input", { bytes: "printf '\\033]2;\\007'\r" }, terminal.surface);
    await s.until("core.grid", (grid) => label(grid) === null, "an empty program title did not remove the title");
  });

  test(`${app.name}: an OSC 9 notification from a terminal out of view becomes a tab notice until the tab is in view`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => closeTerminalTabs(s));
    const [shown, hidden] = await ensureTerminals(s, 2);
    const cardOf = (grid, surface) => grid.cards.find((card) => card.tabs.some((tab) => tab.id === surface));
    const notice = (grid, surface) => cardOf(grid, surface).tabs.find((tab) => tab.id === surface).notice;
    await s.run("core.card.focus", { card: cardOf(await s.get("core.grid"), shown.surface).id });
    await s.until("core.grid", (grid) => cardOf(grid, shown.surface).focused, "the first terminal card did not take focus");
    // 보이는 탭(포커스된 카드의 활성 탭)의 알림은 두지 않는다.
    await s.run("terminal.input", { bytes: "printf '\\033]9;SHOWN-NOTICE\\007'\r" }, shown.surface);
    await s.until("terminal.session", (session) => session.vendor?.notification === "SHOWN-NOTICE",
      "the focused terminal did not receive its notification", { surface: shown.surface });
    assert.equal(notice(await s.get("core.grid"), shown.surface), null, "the tab in view received a notice");
    await s.run("terminal.input", { bytes: "printf '\\033]9;NOTICE-CHECK\\007'\r" }, hidden.surface);
    await s.until("core.grid", (grid) => notice(grid, hidden.surface) === "NOTICE-CHECK",
      "the terminal out of view did not show a tab notice", { timeout: 10000 });
    await s.run("core.card.focus", { card: cardOf(await s.get("core.grid"), hidden.surface).id });
    await s.until("core.grid", (grid) => notice(grid, hidden.surface) === null,
      "the notice stayed after the tab came into view");
  });

  test(`${app.name}: an OSC 9 notification from a terminal out of view follows the system policy and then the tab policy`, async (t) => {
      const s = await open(t, app);
      if (!s) return t.skip(`${app.binary} is not built`);
      await fresh(s);
      s.cleanup(() => closeTerminalTabs(s));
      const [shown, hidden] = await ensureTerminals(s, 2);
      const cardOf = (grid, surface) => grid.cards.find((card) => card.tabs.some((tab) => tab.id === surface));
      await s.run("core.card.focus", { card: cardOf(await s.get("core.grid"), shown.surface).id });
      await s.until("core.grid", (grid) => cardOf(grid, shown.surface).focused, "the first terminal card did not take focus");
      await s.run("core.settings.change", { key: "terminal.notifications", value: "system", scope: "common" });
      await s.run("terminal.input", { bytes: "printf '\\033]9;SYSTEM-POLICY\\007'\r" }, hidden.surface);
      await s.until("terminal.session", (session) => session.vendor?.notification === "SYSTEM-POLICY",
        "the system notification policy did not reach the terminal", { surface: hidden.surface });
      // 시스템 정책의 결과는 게시, native 오류, 거부된 권한 중 하나다. 거부는 게시도 오류도 없이 권한 상태로만
      // 알려진다(V5-111). 애플리케이션 bundle 의 알림 권한은 사용자가 시스템의 질문에 답해야 정해진다.
      const decided = (state) => state.posted.includes(hidden.surface) || state.error !== null || state.authorization === "denied";
      try {
        await s.until("core.notifications", decided,
          "the system notification policy produced neither a post, a native error, nor a denied authorization", { timeout: 10000 });
      } catch (error) {
        const state = await s.get("core.notifications");
        if (state.authorization === "notDetermined") {
          throw new Error(`${app.name}: the notification authorization of this application is not decided; answer its system notification prompt once`, { cause: error });
        }
        throw error;
      }
      assert.equal((await s.get("core.grid")).cards.flatMap((card) => card.tabs).find((tab) => tab.id === hidden.surface).notice,
        null, "the system notification policy fell back to a tab notice");
      await s.run("core.settings.change", { key: "terminal.notifications", value: "tab", scope: "common" });
      const posted = (await s.get("core.notifications")).posted.length;
      await s.run("terminal.input", { bytes: "printf '\\033]9;TAB-NOTICE\\007'\r" }, hidden.surface);
      const notice = (grid, surface) => grid.cards.find((card) => card.tabs.some((tab) => tab.id === surface)).tabs.find((tab) => tab.id === surface).notice;
      await s.until("core.grid", (grid) => notice(grid, hidden.surface) === "TAB-NOTICE",
        "the terminal out of view did not show a tab notice", { timeout: 10000 });
      assert.equal((await s.get("core.notifications")).posted.length, posted, "the tab policy posted a system notification");
      await s.run("core.card.focus", { card: cardOf(await s.get("core.grid"), hidden.surface).id });
      await s.until("core.grid", (grid) => notice(grid, hidden.surface) === null,
        "the tab notice stayed after the tab came into view");
    });

  test(`${app.name}: OSC 8 linked cells are drawn with an underline and plain cells are not`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => closeTerminalTabs(s));
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await s.run("terminal.input", {
      bytes: "clear; printf '\\033]8;;https://example.com/\\007LINKED\\033]8;;\\007 PLAINS\\n'\r",
    }, surface);
    const lines = await readScreenUntil(s, surface, (screen) => screen.includes("LINKED PLAINS"), "the link row did not render");
    const row = lines.indexOf("LINKED PLAINS");
    const session = await s.get("terminal.session", surface);
    await s.request("diagnostics.capture.start", {});
    const displayed = await s.presented();
    const { frames: directory } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
    try {
      const files = frames(directory);
      assert.ok(files.length > 0, "the capture produced no frames");
      const frame = readFrame(files.at(-1));
      const region = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
      const scale = frame.scale;
      const background = pixel(frame, Math.round((region.frame.x + 20.5 * session.cellWidth) * scale),
        Math.round((region.frame.y + (row + 0.5) * session.cellHeight) * scale));
      // 셀 아래쪽 4분의 1에서, 배경과 다른 픽셀이 가장 많은 한 픽셀 행의 픽셀 수를 센다. 밑줄은 셀 폭 전체를
      // 채우는 행이고, 글자 아래 끝은 행의 일부만 채운다.
      const fullestRow = (column0, column1) => {
        const top = Math.round((region.frame.y + (row + 0.75) * session.cellHeight) * scale);
        const bottom = Math.round((region.frame.y + (row + 1) * session.cellHeight) * scale);
        const left = Math.round((region.frame.x + column0 * session.cellWidth) * scale);
        const right = Math.round((region.frame.x + column1 * session.cellWidth) * scale);
        let fullest = 0;
        for (let y = top; y < bottom; y++) {
          let count = 0;
          for (let x = left; x < right; x++) {
            if (pixel(frame, x, y).some((channel, index) => Math.abs(channel - background[index]) > 40)) count++;
          }
          fullest = Math.max(fullest, count);
        }
        return fullest;
      };
      const width = Math.round(6 * session.cellWidth * scale);
      const linked = fullestRow(0, 6);
      const plain = fullestRow(7, 13);
      assert.ok(linked >= width * 0.9, `the fullest row below the linked text has ${linked} of ${width} pixels`);
      assert.ok(plain < width * 0.75, `the fullest row below the plain text has ${plain} of ${width} pixels`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`${app.name}: clear leaves no history and hides the scrollbar`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => closeTerminalTabs(s));
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 60 ]; do echo row$i; i=$((i+1)); done\r" }, surface);
    await s.until("terminal.session", (session) => session.scrollback?.history > 0, "the rows did not exceed the screen", { surface });
    // macOS clear 는 ED 3 과 ED 2 를 보낸다. 사용자가 보고한 명령 그대로 실행한다.
    await s.run("terminal.input", { bytes: "clear; printf '\\n한\\n'\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.trim() === "한"), "the output after clear did not render");
    const session = await s.until("terminal.session", (value) => value.scrollback?.history === 0,
      "clear left lines in the history", { surface });
    const track = await s.rect("terminal.scrollbar", undefined, surface);
    assert.equal(track.width, 0, `the scrollbar is shown without history: ${JSON.stringify({ track, scrollback: session.scrollback })}`);
  });

  test(`${app.name}: a presentation that fails while the terminal service is stopped leaves the next fixture and splits usable`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => closeTerminalTabs(s));
    const [terminal] = await ensureTerminals(s, 1);
    await s.presented();
    // 서비스를 멈추면 분할의 표시가 기존 터미널의 새 래스터를 기다리다 실패한다.
    const { service } = terminalProcessSnapshot(app.configDir);
    process.kill(service, "SIGSTOP");
    let stopped = true;
    s.cleanup(() => { if (stopped) process.kill(service, "SIGCONT"); });
    const card = (await s.get("core.grid")).cards.find((item) => item.active === terminal.surface);
    s.expectPageError(/did not present/);
    const { tab } = await s.run("core.card.split", { card: card.id, side: "right", plugin: "terminal" });
    await s.until("core.page.error", (error) => /did not present/.test(error ?? ""),
      "the presentation did not fail while the terminal service was stopped");
    // 실패 뒤 새 터미널 페이지가 영역을 배치한다. 배치가 끝나거나 표면이 오류를 보고할 때까지 서비스를 멈춰 둔다.
    const placed = s.until("host.window", (value) => value.regions.some((region) => region.surface === tab),
      "the new terminal did not place its region").then(() => null);
    const failure = s.until("core.surfaces", (surfaces) => surfaces.find((item) => item.surface === tab)?.status.phase === "error",
      "the new terminal did not report an error").then((surfaces) => surfaces.find((item) => item.surface === tab).status.error);
    const error = await Promise.race([placed, failure]);
    process.kill(service, "SIGCONT");
    stopped = false;
    assert.equal(error, null, "the new terminal failed to place its region after the failed presentation");
    // 실패한 검사의 정리와 다음 검사의 준비를 같은 순서로 실행한다.
    await closeTerminalTabs(s);
    await fresh(s);
    const terminals = await ensureTerminals(s, 3);
    for (const item of terminals) {
      await s.until("host.window", (value) => value.regions.some((region) => region.surface === item.surface &&
        region.visible && region.presented !== null && region.presented.width === Math.round(region.frame.width * region.presented.scale)),
        `${item.surface} did not present after the failed presentation`);
    }
    const failed = (await s.get("core.surfaces")).filter((item) => item.status.phase === "error");
    assert.deepEqual(failed, [], "a surface reported an error after the failed presentation");
  });

  test(`${app.name}: a terminal split from a terminal starts in the directory that terminal reported`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => closeTerminalTabs(s));
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "soksak-origin ")));
    s.cleanup(() => rmSync(directory, { recursive: true, force: true }));
    const existing = await ensureTerminals(s, 1);
    // 셸 통합이 작업 디렉터리를 알리는 셸로 연다.
    await s.run("core.settings.change", { key: "terminal.shell", value: "/bin/zsh", scope: "common" });
    const terminals = await ensureTerminals(s, existing.length + 1);
    const source = terminals.find((terminal) => !existing.some((item) => item.surface === terminal.surface));
    assert.ok(source, "no new terminal opened after the setting changed");
    await s.until("terminal.session", (session) => session.vendor?.shell?.marker === "prompt.start",
      "zsh did not report an OSC 133 prompt start", { surface: source.surface });
    const quoted = `'${directory.replaceAll("'", "'\\''")}'`;
    await s.run("terminal.input", { bytes: `cd ${quoted}\r` }, source.surface);
    const encoded = directory.split("/").map(encodeURIComponent).join("/");
    await s.until("terminal.session", (session) => session.vendor?.directory?.endsWith(encoded),
      `zsh did not report ${directory}`, { surface: source.surface });
    const card = (await s.get("core.grid")).cards.find((item) => item.active === source.surface);
    const made = await s.run("core.card.split", { card: card.id, side: "right", plugin: "terminal" });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.surface === made.tab && item.visible &&
      item.exposes.includes("status terminal.session")), "the split terminal did not register");
    await s.until("terminal.session", (session) => session.vendor?.shell?.marker === "prompt.start",
      "the split terminal did not show a prompt", { surface: made.tab });
    // 경로 전체 대신 고유한 마지막 이름을 출력한다.
    await s.run("terminal.input", { bytes: "printf 'START=%s\\n' \"$(basename \"$(pwd -P)\")\"\r" }, made.tab);
    // 좁은 카드에서는 출력이 줄바꿈되고 행 끝의 공백은 잘리므로 공백을 빼고 비교한다.
    const printed = `START=${basename(directory)}`.replaceAll(" ", "");
    await readScreenUntil(s, made.tab, (lines) => lines.join("").replaceAll(" ", "").includes(printed),
      `the split terminal did not start in ${directory}`);
  });

  test(`${app.name}: a page start keeps the terminal sessions that the layouts hold`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    const before = await s.until("terminal.session", (state) => Boolean(state?.sessionId), "the terminal session did not open", { surface });
    const shells = terminalProcessSnapshot(app.configDir).shells;

    // 다시 읽은 페이지는 시작할 때 모든 레이아웃의 표면을 남기도록 서비스에 알린다. 레이아웃이 가진 세션은 남는다.
    const log = await s.transcript();
    const document = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (value) => value.timeOrigin !== document && value.readyState === "complete",
      "the main document did not reload");
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.surface === surface && item.exposes.includes("status terminal.session")), "the terminal did not return after the reload");
    const after = await s.until("terminal.session", (state) => Boolean(state?.sessionId), "the terminal session did not return", { surface });
    await log.stop();
    assert.equal(after.sessionId, before.sessionId, "the page start replaced the terminal session");
    assert.deepEqual(terminalProcessSnapshot(app.configDir).shells, shells, "the page start ended a shell that a layout holds");
  });

  test(`${app.name}: hiding three terminals retains native geometry and rasters`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const tab = (await s.get("core.grid")).cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
    assert.ok(tab, "the fixture has no terminal tab");
    await s.run("core.tab.select", { tab: tab.id });
    const terminals = await ensureTerminals(s, 3);
    await s.presented();
    const before = await s.get("host.window");
    for (const terminal of terminals) {
      const image = before.regions.find((region) => region.surface === terminal.surface);
      assert.ok(image?.visible && image.presented && image.frame.width > 0 && image.frame.height > 0,
        `${terminal.surface} must be displayed before hiding`);
    }
    await s.run("core.projects.browse");
    const after = await s.get("host.window");
    for (const terminal of terminals) {
      const shown = before.regions.find((region) => region.surface === terminal.surface);
      const hidden = after.regions.find((region) => region.surface === terminal.surface);
      assert.ok(hidden && !hidden.visible, `${terminal.surface} did not hide`);
      assert.deepEqual(hidden.frame, shown.frame, `hiding ${terminal.surface} changed its native frame`);
      assert.deepEqual(hidden.presented, shown.presented, `hiding ${terminal.surface} changed its raster`);
    }
  });

  test(`${app.name}: three terminals survive repeated divider drags and project returns`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const grid = await s.get("core.grid");
    const tab = grid.cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
    assert.ok(tab, "the fixture has no terminal tab");
    await s.run("core.tab.select", { tab: tab.id });
    const terminals = await ensureTerminals(s, 3);
    const project = await s.get("core.project");
    const cards = (await s.get("core.grid")).cards.filter((card) =>
      terminals.some((terminal) => terminal.surface === card.active)).sort((a, b) => a.x - b.x);
    assert.equal(cards.length, 3, "the test requires three visible terminal cards");
    for (const terminal of terminals) {
      await readScreenUntil(s, terminal.surface,
        (lines) => lines.some((line) => line.includes("$")),
        `${terminal.surface} must show a shell prompt before divider capture`);
      await setMeasuredBackground(s, terminal.surface);
    }
    await s.presented();
    const terminalY = (await s.rect("terminal.view", undefined, terminals[0].surface)).y;
    const checks = await s.collect("core.verify");
    s.cleanup(() => checks.stop());
    const returnSets = 3;
    const roundTripsPerSet = 5;
    const roundTimeout = 60000;
    for (let set = 0; set < returnSets; set++) {
      const roundLabel = `set ${set + 1}/${returnSets}, ${roundTripsPerSet} uninterrupted round trips`;
      const started = Date.now();
      t.diagnostic(`${app.name}: START ${roundLabel}`);
      await within((async () => {
      const trace = await s.transcript();
      const result = await drag(t, s, {
        axis: "x", line: cards[0].c1, dx: 500, dy: 0, ms: 96, times: roundTripsPerSet,
      }, { capture: true });
      const traceLines = await trace.stop();
      const terminalPresentations = traceLines.filter((line) =>
        line.startsWith("host presentSurfaces ") && line.includes('"waitForPresentation":true'));
      assert.ok(terminalPresentations.length > 0,
        `set ${set}: terminal capture had no DOM presentation barrier; ` +
        `presentations=${traceLines.filter((line) => line.startsWith("host presentSurfaces ")).length}`);
      t.diagnostic(`${app.name}: set ${set + 1} terminal presentation barriers ${terminalPresentations.length}`);
      const edgeWidths = [];
      const times = [];
      const positions = frames(result.frameDir).map((file, index) => {
        const frame = readFrame(file);
        times.push(frame.time);
        let boxes;
        try {
          boxes = surfaceBoxes(frame, MEASURED_BACKGROUND, { expectedRow: terminalY }).sort((a, b) => a.card.l - b.card.l);
        } catch (error) {
          throw new Error(`set ${set}, frame ${index} could not measure terminal boxes: ${file}`, { cause: error });
        }
        const terminalBoxes = boxes.filter((box) =>
          Math.abs(box.row / frame.scale - terminalY) <= 5);
        assert.equal(terminalBoxes.length, 3,
          `set ${set}, frame ${index}: every terminal must remain visible; ` +
          `terminalY=${terminalY}, rows=${boxes.map((box) => box.row / frame.scale).join(",")}, file=${file}`);
        for (const box of terminalBoxes) {
          assert.ok(box.l > box.card.l && box.r - 1 < box.card.r,
            `set ${set}, frame ${index}: terminal crosses its DOM border`);
          assert.equal(whitePixels(frame, box), 0, `set ${set}, frame ${index}: terminal has white pixels`);
        }
        const ordered = [...terminalBoxes].sort((a, b) => a.card.l - b.card.l);
        edgeWidths.push({
          left: (ordered[1].card.l - ordered[0].card.l) / frame.scale,
          right: (ordered[2].card.l - ordered[1].card.l) / frame.scale,
        });
        return ordered[1].card.l / frame.scale;
      });
      try {
        // 오래 머문 배치는 모두 녹화에 나와야 한다. 한 번의 표시보다 짧게 머문 위치는 대신될 수 있다.
        assertHeldStatesShown(positions.map((position, index) => ({ time: times[index], position })),
          result.ticks, result.boundary);
      } catch (error) {
        throw new Error(`set ${set}: ${error.message}; frames ${times.length}, first frame ${times[0]}ms, ` +
          `last frame ${times.at(-1)}ms, last presentation ${result.displayed}ms, drag ${result.took}ms, ` +
          `late steps ${result.late}`, { cause: error });
      }
      const span = Math.max(...positions) - Math.min(...positions);
      assert.ok(span >= 50,
        `set ${set}: divider moved only ${span.toFixed(1)}pt; the drag did not move the layout`);
      assert.ok(edgeWidths.some(({ left, right }) => Math.min(left, right) <= 110),
        `set ${set}: no card beside the dragged divider reached the 96pt minimum card edge plus 12pt gap; ` +
        `edges=${JSON.stringify(edgeWidths)}`);
      if (!process.env.SOKSAK_KEEP_FAILURE_CAPTURE) rmSync(result.frameDir, { recursive: true, force: true });
      const beforeHide = await s.get("host.window");
      for (const terminal of terminals) {
        const state = await s.get("terminal.session", terminal.surface);
        assert.equal(state.error, undefined, `set ${set}, ${terminal.surface}: ${state.error}`);
      }
      await s.run("core.projects.browse");
      const hidden = await s.get("host.window");
      assert.equal(hidden.regions.some((region) => region.visible), false,
        "the library must hide every native region");
      for (const terminal of terminals) {
        const before = beforeHide.regions.find((region) => region.surface === terminal.surface);
        const after = hidden.regions.find((region) => region.surface === terminal.surface);
        assert.ok(after, `hiding ${terminal.surface} must retain its native region`);
        assert.deepEqual(after.frame, before.frame, `hiding ${terminal.surface} must not resize or move its native frame`);
        assert.deepEqual(after.presented, before.presented, `hiding ${terminal.surface} must retain its raster`);
      }
      try {
        await s.run("core.library.open", { id: project.id });
      } catch (error) {
        throw new Error(`project return set ${set}: ${error.message}; ${JSON.stringify(await s.get("host.window"))}`,
          { cause: error });
      }
      // surface 모듈은 호스트가 현재 transaction을 표시한 뒤에만 ready를 해제한다.
      // native 사실을 읽기 전에 그 lifecycle 경계를 지킨다.
      const displayed = await s.presented();
      assert.equal(typeof displayed.displayed, "number", `project return set ${set} did not report a displayed frame`);
      const state = await s.get("host.window");
      for (const terminal of terminals) {
        const image = state.regions.find((region) => region.surface === terminal.surface);
        assert.ok(image?.visible && image.presented, `terminal ${terminal.surface} did not return in set ${set}`);
        assert.equal(image.error, null, `terminal ${terminal.surface} reported a native error`);
        assert.equal(image.presented.width, Math.round(image.frame.width * image.presented.scale));
        assert.equal(image.presented.height, Math.round(image.frame.height * image.presented.scale));
      }
      const failures = checks.values.filter((value) => value?.failed > 0);
      assert.deepEqual(failures, [], `project return set ${set} reported a composition failure`);
      })(), roundTimeout, `${app.name}: ${roundLabel}`);
      t.diagnostic(`${app.name}: PASS ${roundLabel} (${Date.now() - started}ms)`);
    }
  });

  test(`${app.name}: terminal input returns terminal output through the terminal sidecar`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await assertGridFillsPlane(s, "initial terminal layout");

    // 터미널 탭을 활성화한다. core.grid 는 상태이므로 상태 읽기로 카드와 탭을 얻는다.
    const grid = await s.get("core.grid");
    const card = grid.cards.find((c) => c.tabs.some((tab) => tab.plugin === "terminal"));
    if (!card) return t.skip("terminal tab not found");
    const terminalTab = card.tabs.find((tab) => tab.plugin === "terminal");

    // 터미널 탭을 선택하는 명령을 실행한다.
    await s.run("core.tab.select", { tab: terminalTab.id });

    // 터미널 세션이 준비될 때까지 기다린다.
    let terminalSurface;
    await s.until(
      "core.surfaces",
      (surfaces) => {
        const terminal = surfaces.find(
          (surf) => surf.visible && surf.plugin === "terminal" &&
            surf.exposes.includes("status terminal.session")
        );
        if (!terminal) return false;
        terminalSurface = terminal.surface;
        return true;
      },
      "terminal surface did not become visible"
    );

    // 터미널 sessionId 가 생길 때까지 기다린다.
    await s.until(
      "terminal.session",
      (session) => session && session.sessionId,
      "terminal session did not report sessionId",
      { surface: terminalSurface }
    );
    await setMeasuredBackground(s, terminalSurface);

    // 명령을 보낸다.
    await s.run("terminal.input", { bytes: "echo hi\r" }, terminalSurface);

    // 출력 줄을 읽을 때까지 기다린다.
    // 화면이 읽혔는지 확인한다.
    const screenLines = await readScreenUntil(
      s,
      terminalSurface,
      (screen) => screen.some((line) => line.trim() === "hi"),
      'terminal output does not contain "hi"'
    );

    // 창 캡처로 터미널 영역에 글자가 나왔는지 확인한다.
    const terminalRect = await s.rect("terminal.view", undefined, terminalSurface);
    const capture = await s.request("diagnostics.capture.start", {});

    // 캡처를 즉시 중지하되, 마지막 표시 시각까지의 프레임을 기록한다.
    const { frames: frameDir } = await s.request("diagnostics.capture.stop", {
      after: (await s.presented()).displayed,
    });

    s.cleanup(async () => {
      await closeTerminalTabs(s);
      rmSync(frameDir, { recursive: true, force: true });
    });

    const frameFiles = frames(frameDir);
    assert.ok(frameFiles.length > 0, "no frames were captured");

    // 마지막 프레임을 읽는다.
    const lastFramePath = frameFiles[frameFiles.length - 1];
    const frame = readFrame(lastFramePath);

    // 터미널 영역 내에서 네이티브 IOSurface 가 덮고 있고 글자가 나왔는지 확인한다.
    const BG_COLOR = MEASURED_BACKGROUND;
    const COLOR_TOLERANCE = 10;
    const BRIGHT_TEXT_THRESHOLD = 160;
    const BRIGHT_TEXT_MIN = 20;
    const BG_SAMPLE_RATIO_MIN = 0.5;

    // 창 좌표는 point 이고 frame 은 device pixel 이므로 frame 배율을 곱한다.
    const termX = Math.round(terminalRect.x * frame.scale);
    const termY = Math.round(terminalRect.y * frame.scale);
    const termWidth = Math.round(terminalRect.width * frame.scale);
    const termHeight = Math.round(terminalRect.height * frame.scale);

    let bgPixelCount = 0;
    let totalSampleCount = 0;
    let brightTextCount = 0;

    // 두 픽셀마다 하나씩 표본 추출하여 배경 비율과 밝은 픽셀 개수를 센다.
    for (let y = termY; y < termY + termHeight; y += 2) {
      for (let x = termX; x < termX + termWidth; x += 2) {
        if (y < 0 || y >= frame.height || x < 0 || x >= frame.width) continue;
        const px = pixel(frame, x, y);
        totalSampleCount++;

        // (a) 배경색 픽셀 개수
        const isBG = px.every((v, i) => Math.abs(v - BG_COLOR[i]) <= COLOR_TOLERANCE);
        if (isBG) bgPixelCount++;

        // (b) 밝은 픽셀 개수
        const brightness = (px[0] + px[1] + px[2]) / 3;
        if (brightness >= BRIGHT_TEXT_THRESHOLD) brightTextCount++;
      }
    }

    const bgRatio = totalSampleCount > 0 ? bgPixelCount / totalSampleCount : 0;
    assert.ok(
      bgRatio >= BG_SAMPLE_RATIO_MIN,
      `terminal IOSurface not detected: ${(bgRatio * 100).toFixed(1)}% background (need >= ${(BG_SAMPLE_RATIO_MIN * 100).toFixed(0)}%)`
    );
    assert.ok(
      brightTextCount >= BRIGHT_TEXT_MIN,
      `terminal text not visible: ${brightTextCount} bright pixels (need >= ${BRIGHT_TEXT_MIN})`
    );
  });

  test(`${app.name}: inline image pixels follow scroll, resize, replacement, deletion, and cleanup`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    s.cleanup(() => closeTerminalTabs(s));
    await s.until("terminal.session", (state) => Boolean(state?.sessionId && state.rows > 8),
      "inline-image terminal session did not open", { surface });
    // 셸이 프롬프트를 낸 뒤에 입력한다. 그 전의 입력은 터미널이 먼저 한 번 보여 준다.
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes("$")), "the shell prompt did not appear");

    const red = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=";
    const blue = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGNgYPj/H4QBDfsD/Yde1YcAAAAASUVORK5CYII=";
    const name = "cGxvdA==";
    const image = (data) => `printf '\\033[6;1H\\033]1337;File=name=${name};inline=1;width=4px;height=4px:${data}\\a'`;
    const redInput = `${image(red)}\r`;
    await s.run("terminal.input", { bytes: redInput }, surface);
    await s.until("terminal.session", (state) => state.inlineImages?.includes("plot"),
      "inline image display event was not observed", { surface });
    const beforeScroll = await terminalColorBounds(s, surface, "red");
    assert.ok(beforeScroll.count >= 2, `red inline image did not reach native pixels: ${beforeScroll.count}; ${beforeScroll.measured}`);
    t.diagnostic(`${app.name}: inline image displayed ${beforeScroll.count} red pixels`);

    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 100 ]; do printf '\\n'; i=$((i+1)); done; printf '\\nSCROLL_DONE\\n'\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.includes("SCROLL_DONE"),
      "terminal did not finish the scroll fixture");
    const afterScroll = await terminalColorBounds(s, surface, "red");
    t.diagnostic(`${app.name}: after scroll red pixels ${afterScroll.count} y=${afterScroll.minY}-${afterScroll.maxY}`);
    assert.equal(afterScroll.count, 0, "scrolled-off inline image remained visible at a stale absolute position");
    assert.ok((await s.get("terminal.session", surface)).inlineImages.includes("plot"),
      "scrolling deleted inline-image ownership instead of hiding its placement");

    await s.run("terminal.input", { bytes: `${image(blue)}; printf '\\nREPLACE_DONE\\n'\r` }, surface);
    await readScreenUntil(s, surface, (lines) => lines.includes("REPLACE_DONE"),
      "terminal did not finish the replacement fixture");
    const replaced = await terminalColorBounds(s, surface, "blue");
    assert.ok(replaced.count >= 1, `same-name replacement did not reach native pixels: ${replaced.count}; ${replaced.measured}`);
    const redAfterReplacement = await terminalColorBounds(s, surface, "red");
    assert.ok(redAfterReplacement.count < beforeScroll.count / 2,
      `same-name replacement retained the old image: ${redAfterReplacement.count}`);

    await s.run("terminal.image.inline.delete", { name: "plot" }, surface);
    await s.until("terminal.session", (state) => !state.inlineImages?.includes("plot"),
      "inline image deletion event was not observed", { surface });
    const deleted = await terminalColorBounds(s, surface, "blue");
    t.diagnostic(`${app.name}: after delete blue pixels ${deleted.count} y=${deleted.minY}-${deleted.maxY}`);
    assert.equal(deleted.count, 0, "inline image deletion left blue pixels in the native raster");
    const screen = await readScreenUntil(s, surface, (lines) => lines.length > 0,
      "terminal screen disappeared after inline image deletion");
    assert.ok(Array.isArray(screen), "terminal text state was not retained after image deletion");
    await s.run("host.window.resize", { width: 800, height: 920 });
    const resizedScreen = await readScreenUntil(s, surface, (lines) => lines.length > 0,
      "terminal screen disappeared after resize");
    assert.ok(Array.isArray(resizedScreen), "terminal text state was not retained after resize");
    t.diagnostic(`${app.name}: PASS inline image lifecycle (scroll/resize/replace/delete)`);
  });

  test(`${app.name}: the terminal background equals the card color of every theme and mode`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    s.cleanup(async () => {
      await s.run("core.settings.theme", { name: "midnight", mode: "dark", scope: "common" });
      await closeTerminalTabs(s);
    });
    await s.until("terminal.session", (state) => Boolean(state?.sessionId && state.theme),
      "terminal session did not report its effective theme", { surface: terminal.surface });
    const rect = await s.rect("terminal.view", undefined, terminal.surface);
    // 테마 값은 워크벤치가 보고하는 테마 목록 그대로다.
    const THEMES = await s.get("core.themes");
    for (const { name: theme } of THEMES) {
      for (const mode of ["dark", "light"]) {
        await s.run("core.settings.theme", { name: theme, mode, scope: "common" });
        // 터미널 배경은 카드 색(--card)이다.
        const token = THEMES.find((item) => item.name === theme)[mode].card;
        await s.until("terminal.session", (state) => state?.theme === mode && state.background === token,
          `the terminal did not apply ${theme} ${mode} background ${token}`, { surface: terminal.surface });
        const sample = await terminalBackgroundSample(s, rect);
        const expected = [1, 3, 5].map((at) => parseInt(token.slice(at, at + 2), 16));
        assert.ok(sample.every((value, index) => Math.abs(value - expected[index]) <= 2),
          `${theme} ${mode}: the terminal background pixel is rgb(${sample}), the card token is ${token}`);
      }
    }
  });

  test(`${app.name}: terminal raster follows application light and dark theme`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.surface === terminal.surface && item.exposes.includes("status terminal.session")),
    "terminal session status did not register");
    await s.until("terminal.session", (state) => Boolean(state?.sessionId && state.theme),
      "terminal session did not report its effective theme", { surface: terminal.surface });
    const original = (await s.get("core.settings")).values.mode;
    const other = original === "dark" ? "light" : "dark";
    const rect = await s.rect("terminal.view", undefined, terminal.surface);
    const darkSample = original === "dark" ? await terminalBackgroundSample(s, rect) : null;
    const lightSample = original === "light" ? await terminalBackgroundSample(s, rect) : null;
    const sessionBefore = await s.get("terminal.session", terminal.surface);
    s.cleanup(async () => {
      await s.run("core.settings.theme", { name: "midnight", mode: original, scope: "common" });
      await closeTerminalTabs(s);
    });

    await s.run("core.settings.theme", { name: "midnight", mode: other, scope: "common" });
    await s.until("core.settings", (settings) => settings.values.mode === other && !settings.saving,
      `application theme did not switch to ${other}`);
    const switched = await s.until("terminal.session", (state) => state?.theme === other,
      `terminal did not acknowledge ${other} theme`, { surface: terminal.surface });
    const switchedSample = await terminalBackgroundSample(s, rect);
    if (other === "light") assert.ok(switchedSample[0] > 200 && switchedSample[1] > 200 && switchedSample[2] > 200,
      `light terminal background pixel was not light: ${switchedSample}`);
    else assert.ok(switchedSample[0] < 80 && switchedSample[1] < 80 && switchedSample[2] < 80,
      `dark terminal background pixel was not dark: ${switchedSample}`);
    assert.equal(switched.sessionId, sessionBefore.sessionId, "theme switch recreated the terminal session");
    assert.equal(switched.cellWidth, sessionBefore.cellWidth, "theme switch changed cell width");
    assert.equal(switched.cellHeight, sessionBefore.cellHeight, "theme switch changed cell height");
    if (other === "light") assert.ok(darkSample === null || switchedSample.some((value, index) => Math.abs(value - darkSample[index]) > 100),
      `light and dark background pixels did not differ: ${darkSample} -> ${switchedSample}`);
    else assert.ok(lightSample === null || switchedSample.some((value, index) => Math.abs(value - lightSample[index]) > 100),
      `dark and light background pixels did not differ: ${lightSample} -> ${switchedSample}`);
  });

  test(`${app.name}: terminal cursor policy uses declared settings, persistence, and pixels`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const cursorKeys = [
      "terminal.cursor.shape", "terminal.cursor.blink", "terminal.cursor.interval",
      "terminal.cursor.idleTimeout", "terminal.cursor.unfocused",
    ];
    s.cleanup(async () => {
      for (const key of cursorKeys) await s.run("core.settings.reset", { key });
      await closeTerminalTabs(s);
    });
    await s.until("terminal.session", (state) => Boolean(state?.sessionId),
      "terminal session did not open", { surface: terminal.surface });
    const terminalView = await s.rect("terminal.view", undefined, terminal.surface);
    await s.click(terminalView.document.x + terminalView.x + terminalView.width / 2,
      terminalView.document.y + terminalView.y + terminalView.height / 2);
    await s.until("host.window", (host) => host.regions.some((region) =>
      region.surface === terminal.surface && region.focused),
    "terminal did not receive focus before cursor capture");
    const before = await terminalCursorCell(s, terminal.surface);
    await s.run("core.settings.open");
    const modalControl = async (key) => {
      const modal = await s.until("core.settings-modal", (state) =>
        state.controls.some((control) => control.key === key),
      `settings control ${key} did not appear`);
      return modal.controls.find((control) => control.key === key);
    };
    // 터미널 설정은 플러그인 구역의 터미널 페이지에 있다. 두 단계 모두 선언된 컨트롤의 명령으로 연다.
    const plugins = await modalControl("nav:plugins");
    await s.run(plugins.command.name, plugins.command.params);
    const page = await modalControl("plugin:terminal");
    await s.run(page.command.name, page.command.params);
    await s.until("core.settings-modal", (modal) => modal.plugin === "terminal", "the terminal settings page did not open");
    // 선택지는 선택 상자다. 고른 값은 그 컨트롤이 가리키는 명령의 value 로 간다(docs/spec/settings.md 의 Controls).
    const pick = async (setting, expected) => {
      const control = await modalControl(setting);
      assert.ok(control.command, `settings control ${setting} has no command`);
      assert.ok(control.options?.includes(expected), `settings control ${setting} does not offer ${expected}`);
      await s.run(control.command.name, { ...control.command.params, value: expected });
      await s.until("core.settings", (state) => state.values[setting] === expected && !state.saving,
        `settings command did not apply ${setting}=${expected}`);
    };
    await pick("terminal.cursor.shape", "underline");
    await pick("terminal.cursor.blink", "Never");
    await pick("terminal.cursor.unfocused", "beam");
    // 숫자 설정은 값 입력 컨트롤이 가리키는 명령으로 바꾼다.
    const enter = async (key, value) => {
      const modal = await s.until("core.settings-modal", (state) =>
        state.controls.some((control) => control.name === "core.settings-modal.set" && control.key === key),
      `settings value control ${key} did not appear`);
      const control = modal.controls.find((item) => item.name === "core.settings-modal.set" && item.key === key);
      assert.ok(control.command, `settings value control ${key} has no command`);
      await s.run(control.command.name, { ...control.command.params, value: String(value) });
      await s.until("core.settings", (state) => state.values[key] === value && !state.saving,
        `settings value control did not apply ${key}=${value}`);
    };
    await enter("terminal.cursor.interval", 900);
    await enter("terminal.cursor.idleTimeout", 0);
    await s.run("core.settings.close");

    await s.until("terminal.cursor", (state) => state.unfocused === "beam" && state.blink === "Never" &&
      state.interval === 900 && state.idleTimeout === 0,
    "terminal did not receive the effective cursor settings", { surface: terminal.surface });
    await s.presented();
    const after = await terminalCursorCell(s, terminal.surface);
    assert.ok(differentPixels(before.surface, after.surface) > 0,
      "cursor policy did not change actual terminal surface pixels");
    await s.run("core.settings.set", {
      patch: { "terminal.cursor.shape": "beam" },
      scope: "project",
    });
    await s.until("core.settings", (state) => state.values["terminal.cursor.shape"] === "beam" && !state.saving,
      "project cursor setting was not persisted");
    await s.until("terminal.cursor", (state) => state.shape === "beam",
      "project cursor setting did not reach the sidecar", { surface: terminal.surface });
    await s.run("core.settings.reset", { key: "terminal.cursor.shape" });
    await s.until("core.settings", (state) => state.values["terminal.cursor.shape"] === "underline" && !state.saving,
      "project cursor reset did not restore the common value");
    await s.until("terminal.cursor", (state) => state.shape === "underline",
      "common cursor value was not restored after project reset", { surface: terminal.surface });
    assert.equal(await failure(s.run("core.settings.set", {
      patch: { "terminal.cursor.interval": 0 }, scope: "common",
    })), -32602, "invalid cursor setting must fail explicitly");
    assert.equal((await s.get("core.settings")).values["terminal.cursor.interval"], 900,
      "invalid cursor setting must not replace the effective value");
  });

  test(`${app.name}: each cursor shape and focus state renders its own cursor-cell pixels`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    const keys = ["terminal.cursor.shape", "terminal.cursor.blink", "terminal.cursor.unfocused"];
    s.cleanup(async () => {
      for (const key of keys) await s.run("core.settings.reset", { key });
      await closeTerminalTabs(s);
    });
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.endsWith("$")), "shell prompt missing");
    const set = async (patch) => {
      await s.run("core.settings.set", { patch, scope: "common" });
      const [key, value] = Object.entries(patch)[0];
      const field = { "terminal.cursor.shape": "shape", "terminal.cursor.blink": "blink", "terminal.cursor.unfocused": "unfocused" }[key];
      await s.until("terminal.cursor", (state) => state[field] === value, `the terminal did not apply ${key}=${value}`, { surface });
    };
    // 깜박임을 끄면 커서는 한 모양으로 머문다.
    await set({ "terminal.cursor.blink": "Never" });

    // 커서 칸의 장치 픽셀에서 배경과 다른 픽셀의 비율을 테두리 띠와 안쪽으로 나누어 잰다.
    const measure = async (label) => {
      const cursor = await s.run("terminal.screen.read", {}, surface).then(() => s.get("terminal.cursor", surface));
      await s.presented();
      await s.request("diagnostics.capture.start", {});
      const displayed = await s.presented();
      const { frames: frameDir } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
      try {
        const files = frames(frameDir);
        assert.ok(files.length > 0, `${label}: the capture produced no frames`);
        const frame = readFrame(files.at(-1));
        const region = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
        const state = await s.get("terminal.session", surface);
        const x0 = Math.round((region.frame.x + cursor.col * state.cellWidth) * frame.scale);
        const y0 = Math.round((region.frame.y + cursor.row * state.cellHeight) * frame.scale);
        const width = Math.floor(state.cellWidth * frame.scale);
        const height = Math.floor(state.cellHeight * frame.scale);
        const background = pixel(frame, Math.round((region.frame.x + region.frame.width - 3) * frame.scale),
          Math.round((region.frame.y + region.frame.height - 3) * frame.scale));
        const ink = (x, y) => pixel(frame, x0 + x, y0 + y).some((value, index) => Math.abs(value - background[index]) > 60);
        const band = (fx, fy, fw, fh) => {
          let count = 0;
          for (let y = fy; y < fy + fh; y++) for (let x = fx; x < fx + fw; x++) if (ink(x, y)) count++;
          return count / (fw * fh);
        };
        // 커서 선은 2장치 픽셀이다. 띠는 칸 가장자리의 장치 픽셀 한 줄이고, 안쪽은 그 선 안쪽이다.
        const line = 2;
        // 실패 보고용: 커서 칸과 그 둘레 한 칸의 잉크 지도.
        const map = [];
        for (let y = -height; y < 2 * height; y++) {
          let row = "";
          for (let x = -width; x < 2 * width; x++) row += ink(x, y) ? "#" : ".";
          map.push(row);
        }
        return {
          label,
          cell: { col: cursor.col, row: cursor.row, x0, y0, width, height, scale: frame.scale },
          top: band(line, 0, width - 2 * line, 1),
          bottom: band(line, height - 1, width - 2 * line, 1),
          left: band(0, line, 1, height - 2 * line),
          right: band(width - 1, line, 1, height - 2 * line),
          inside: band(line + 1, line + 1, width - 2 * line - 2, height - 2 * line - 2),
          map,
        };
      } finally {
        rmSync(frameDir, { recursive: true, force: true });
      }
    };
    const expect = (value, shape) => {
      const full = (v) => v > 0.8;
      const empty = (v) => v < 0.1;
      const rules = {
        block: full(value.top) && full(value.bottom) && full(value.left) && full(value.right) && full(value.inside),
        hollow: full(value.top) && full(value.bottom) && full(value.left) && full(value.right) && empty(value.inside),
        underline: full(value.bottom) && empty(value.top) && empty(value.right) && empty(value.inside),
        beam: full(value.left) && empty(value.right) && empty(value.top) && empty(value.inside),
        hidden: empty(value.top) && empty(value.bottom) && empty(value.left) && empty(value.right) && empty(value.inside),
      };
      const { map, ...bands } = value;
      assert.ok(rules[shape], `${value.label} did not render a ${shape} cursor: ${JSON.stringify(bands)}\n${map.join("\n")}`);
    };

    // 포커스 전: 포커스 없는 커서 설정이 모양을 정한다.
    await s.until("host.window", (host) => host.regions.some((region) => region.surface === surface && !region.focused),
      "the terminal started with keyboard focus");
    for (const [unfocused, shape] of [["hollow", "hollow"], ["solid", "block"], ["underline", "underline"], ["beam", "beam"]]) {
      await set({ "terminal.cursor.unfocused": unfocused });
      expect(await measure(`unfocused ${unfocused}`), shape);
    }
    await set({ "terminal.cursor.unfocused": "hollow" });

    // 포커스 뒤: 커서 모양 설정이 모양을 정한다.
    const view = await s.rect("terminal.view", undefined, surface);
    await s.click(view.document.x + view.x + view.width / 2, view.document.y + view.y + view.height / 2);
    await s.until("host.window", (host) => host.regions.some((region) => region.surface === surface && region.focused),
      "the terminal did not receive keyboard focus");
    for (const shape of ["block", "underline", "beam"]) {
      await set({ "terminal.cursor.shape": shape });
      expect(await measure(`focused ${shape}`), shape);
    }

    // 프로그램이 숨긴 커서는 그리지 않는다.
    await s.run("terminal.input", { bytes: "printf '\\033[?25l'\r" }, surface);
    await s.until("terminal.cursor", (state) => state.visible === false, "the program did not hide the cursor", { surface });
    expect(await measure("hidden"), "hidden");
  });

  test(`${app.name}: the terminal font follows the pressed card's text size`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    s.cleanup(() => closeTerminalTabs(s));
    await s.until("terminal.session", (state) => Boolean(state?.sessionId) && state.fontSize === 13,
      "the terminal did not open at 13 points", { surface });
    // 빨간 글자 한 줄의 픽셀 높이가 그려진 글꼴 크기를 나타낸다.
    const red = async (marker) => {
      await s.run("terminal.input", { bytes: `printf '\\033[2J\\033[H\\033[31m${marker}\\033[0m\\n'\r` }, surface);
      await readScreenUntil(s, surface, (lines) => lines.some((line) => line.trim() === marker), `${marker} did not render`);
      await s.presented();
      return terminalColorBounds(s, surface, "red");
    };
    const before = await s.get("terminal.session", surface);
    const glyphBefore = await red("HGHGHG");
    assert.ok(glyphBefore.count > 0, "the red text was not found in the terminal pixels");
    const view = await s.rect("terminal.view", undefined, surface);
    await s.click(view.document.x + view.x + view.width / 2, view.document.y + view.y + view.height / 2);
    await s.until("core.text", (value) => value.scope.kind === "card", "pressing the terminal card did not make it the scope");
    const titles = await largerTitle(s);
    await s.run("host.menu.select", { menu: titles.menu, title: titles.larger });
    await s.run("host.menu.select", { menu: titles.menu, title: titles.larger });
    const after = await s.until("terminal.session", (state) => state.fontSize === 13 * 1.25,
      "the terminal font did not reach 13 points times 1.25", { surface });
    const cell = after.cellHeight / before.cellHeight;
    assert.ok(Math.abs(cell - 1.25) <= 0.1, `the cell height must grow with the factor: ${before.cellHeight} → ${after.cellHeight}`);
    const glyphAfter = await red("HGHGHG");
    const glyph = (glyphAfter.maxY - glyphAfter.minY + 1) / (glyphBefore.maxY - glyphBefore.minY + 1);
    assert.ok(Math.abs(glyph - 1.25) <= 0.15,
      `the rendered glyph height must grow with the factor: ${JSON.stringify(glyphBefore)} → ${JSON.stringify(glyphAfter)}`);
  });

  test(`${app.name}: a native drag over blank terminal cells ends without a surface error`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    s.cleanup(() => closeTerminalTabs(s));
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.surface === surface && item.exposes.includes("status terminal.session")),
    "terminal selection status did not register");
    await s.until("terminal.session", (state) => Boolean(state?.sessionId),
      "terminal selection session did not open", { surface });
    const marker = "BLANK-SELECTION-1";
    await s.run("terminal.input", { bytes: `printf '\\033[2J\\033[H${marker}\\n'\r` }, surface);
    await readScreenUntil(s, surface, (screen) => screen.some((line) => line.trim() === marker),
      "terminal blank selection marker did not render");

    const view = await s.rect("terminal.view", undefined, surface);
    const metrics = await s.get("terminal.session", surface);
    assert.ok(metrics.rows > 4 && metrics.cols > 20, `terminal grid is too small: ${metrics.cols}×${metrics.rows}`);
    const row = metrics.rows - 2;
    const viewX = view.document.x + view.x;
    const y = view.document.y + view.y + (row + 0.5) * metrics.cellHeight;
    const released = metrics.selectionReleases;
    await s.pointer(viewX + 5.5 * metrics.cellWidth, y, "down", { button: "left" });
    await s.pointer(viewX + 20.5 * metrics.cellWidth, y, "drag", { button: "left" });
    await s.pointer(viewX + 20.5 * metrics.cellWidth, y, "up", { button: "left" });
    // 사이드카가 해제에 답하거나 오류를 보고할 때까지 기다린다.
    const state = await s.until("terminal.session",
      (value) => value?.selectionReleases > released || value?.error !== undefined,
      "the sidecar did not answer the selection release", { surface });
    // 선택한 칸은 테마의 선택 배경으로 그리고 페이지의 화면 셀에는 색이 없으므로, 끈 구간을 픽셀로 잰다.
    const selection = await selectionBackground(s);
    const columns = Array.from({ length: 16 }, (_, index) => 5 + index);
    const shown = await cellBackgrounds(s, surface, columns.map((col) => ({ col, row })));
    const selected = columns.filter((col, index) => isColor(shown[index], selection));
    assert.equal(state.error, undefined,
      `a drag over blank row ${row} reported ${state.error}; selected cells in columns 5–20: ${selected.join(",")}`);
    assert.deepEqual(state.unsupported, [], "the sidecar answers of the drag are declared events");
    assert.deepEqual(selected, [], `the blank selection was not cleared: columns ${selected.join(",")} of row ${row} ` +
      `are drawn on the selection background ${selection}`);
  });

  test(`${app.name}: a native drag into the padding below the last row selects to the last row`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    s.cleanup(() => closeTerminalTabs(s));
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.surface === surface && item.exposes.includes("status terminal.session")),
    "terminal selection status did not register");
    await s.until("terminal.session", (state) => Boolean(state?.sessionId),
      "terminal selection session did not open", { surface });
    const marker = "PADDING-SELECTION-1";
    await s.run("terminal.input", { bytes: `printf '\\033[2J\\033[H${marker}\\n'\r` }, surface);
    await readScreenUntil(s, surface, (screen) => screen.some((line) => line.trim() === marker),
      "terminal padding selection marker did not render");

    const view = await s.rect("terminal.view", undefined, surface);
    const metrics = await s.get("terminal.session", surface);
    const padding = view.height - metrics.rows * metrics.cellHeight;
    assert.ok(padding >= 1 && padding < metrics.cellHeight,
      `the view must leave padding below the last row: ${view.height} for ${metrics.rows} rows of ${metrics.cellHeight}`);
    const viewX = view.document.x + view.x;
    const top = view.document.y + view.y;
    const released = metrics.selectionReleases;
    await s.pointer(viewX + 0.5 * metrics.cellWidth, top + 0.5 * metrics.cellHeight, "down", { button: "left" });
    // 선택은 포인터가 칸의 가로 가운데를 지나야 그 칸을 덮는다(docs/spec/terminal-runtime.md). 넷째 칸의 가운데 앞까지
    // 끌면 마지막 행의 앞 세 칸, 가운데를 지나면 네 칸이다. 사이드카는 끌기를 차례로 처리하므로 화면 읽기의 답은 선택을
    // 반영한 뒤에 온다. 선택은 색으로만 보이므로 픽셀로 잰다.
    const selection = await selectionBackground(s);
    const last = metrics.rows - 1;
    const below = top + metrics.rows * metrics.cellHeight + padding / 2;
    for (const [column, expected] of [[3.4, [true, true, true, false]], [3.6, [true, true, true, true]]]) {
      await s.pointer(viewX + column * metrics.cellWidth, below, "drag", { button: "left" });
      await s.run("terminal.screen.read", {}, surface);
      const shown = await cellBackgrounds(s, surface, [0, 1, 2, 3].map((col) => ({ col, row: last })));
      assert.deepEqual(shown.map((sample) => isColor(sample, selection)), expected,
        `a drag into the bottom padding to column ${column} selected other cells of the last row: ${JSON.stringify(shown)} ` +
          `against the selection background ${selection}`);
    }
    await s.pointer(viewX + 3.6 * metrics.cellWidth, below, "up", { button: "left" });
    const state = await s.until("terminal.session",
      (value) => value?.selectionReleases > released || value?.error !== undefined,
      "the sidecar did not answer the selection release", { surface });
    assert.equal(state.error, undefined, `a drag into the bottom padding reported ${state.error}`);
  });

  test(`${app.name}: native terminal selection renders and copies through one explicit paste`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    s.cleanup(() => closeTerminalTabs(s));
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.surface === surface && item.exposes.includes("status terminal.session")),
    "terminal selection status did not register");
    await s.until("terminal.session", (state) => Boolean(state?.sessionId),
      "terminal selection session did not open", { surface });

    const transcript = await s.transcript();
    s.cleanup(() => transcript.stop());
    // 선택 제스처 동안 터미널 화면이 바뀌었는지 실패 보고에 쓴다.
    const screens = [];
    const offScreens = s.client.on("status.changed", (params) => {
      if (params?.name === "terminal.screen" && params.surface === surface) {
        screens.push(params.value.map((cells) => cells.map((cell) => cell.ch).join("").trimEnd()).slice(0, 3));
      }
    });
    await s.request("status.watch", { name: "terminal.screen", surface });
    s.cleanup(async () => {
      offScreens();
      await s.request("status.unwatch", { name: "terminal.screen", surface });
    });
    const marker = "SELECTION-CLIP-123";
    await s.run("terminal.input", { bytes: `printf '\\033[2J\\033[H${marker}\\n'\r` }, surface);
    const lines = await readScreenUntil(s, surface,
      (screen) => screen.some((line) => line.trim() === marker),
      "terminal selection marker did not render");
    const row = lines.findIndex((line) => line.trim() === marker);
    assert.ok(row >= 0, "terminal selection marker row was not found");
    const col = lines[row].indexOf(marker);
    assert.ok(col >= 0, "terminal selection marker column was not found");

    const view = await s.rect("terminal.view", undefined, surface);
    const metrics = await s.get("terminal.session", surface);
    assert.ok(metrics.cellWidth > 0 && metrics.cellHeight > 0, "terminal cell metrics are unavailable");
    const before = await terminalFrame(s);
    const viewX = view.document.x + view.x;
    const viewY = view.document.y + view.y;
    // 선택은 포인터가 칸의 가운데를 지나야 그 칸을 덮으므로 첫 칸의 왼쪽 가장자리 가까이에서 누른다.
    const start = {
      x: viewX + (col + 0.2) * metrics.cellWidth,
      y: viewY + (row + 0.5) * metrics.cellHeight,
    };
    const end = {
      x: viewX + (col + marker.length - 0.5) * metrics.cellWidth,
      y: start.y,
    };
    const screensBefore = screens.length;
    await s.pointer(start.x, start.y, "down", { button: "left" });
    await s.pointer(end.x, end.y, "drag", { button: "left" });
    await s.pointer(end.x, end.y, "up", { button: "left" });
    await s.presented();
    const selected = await s.get("terminal.session", surface);
    if (selected.error !== undefined) {
      const screen = await s.get("terminal.screen", surface);
      assert.fail(`native selection reported ${selected.error}; marker at row ${row}, col ${col}; ` +
        `pointer ${JSON.stringify(start)} → ${JSON.stringify(end)}; screen before selection ${JSON.stringify(lines.slice(0, row + 3))}; ` +
        `screen after selection ${JSON.stringify(screen.slice(0, row + 3).map((cells) => cells.map((cell) => cell.inverse ? cell.ch.toUpperCase() + "*" : cell.ch).join("")))}; ` +
        `grid before ${metrics.cols}×${metrics.rows} at ${metrics.cellWidth}×${metrics.cellHeight}, ` +
        `after ${selected.cols}×${selected.rows} at ${selected.cellWidth}×${selected.cellHeight}; ` +
        `transcript ${JSON.stringify(transcript.lines.slice(-10))}; ` +
        `screens during the gesture ${JSON.stringify(screens.slice(screensBefore))}, last before ${JSON.stringify(screens[screensBefore - 1])}`);
    }

    const after = await terminalFrame(s);
    let changed = 0;
    // 창 좌표는 point 이고 frame 은 device pixel 이므로 frame 배율을 곱한다.
    const scale = after.scale;
    const x0 = Math.max(0, Math.round((viewX + col * metrics.cellWidth) * scale));
    const x1 = Math.min(after.width, Math.round((viewX + (col + marker.length) * metrics.cellWidth) * scale));
    const y0 = Math.max(0, Math.round((viewY + row * metrics.cellHeight) * scale));
    const y1 = Math.min(after.height, Math.round((viewY + (row + 1) * metrics.cellHeight) * scale));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const oldPixel = pixel(before, x, y);
        const newPixel = pixel(after, x, y);
        if (oldPixel.some((value, index) => value !== newPixel[index])) changed++;
      }
    }
    assert.ok(changed > 0, "native selection did not change the selected raster pixels");

    await s.run("terminal.paste", {}, surface);
    const pasted = await readScreenUntil(s, surface,
      (screen) => screen.filter((line) => line.includes(marker)).length >= 2,
      "explicit paste did not return the selected text to the terminal");
    assert.ok(pasted.filter((line) => line.includes(marker)).length >= 2,
      "selection clipboard text was not pasted exactly as selected");
  });

  test(`${app.name}: an explicit PNG paste writes an owned image and inserts its quoted path`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    s.cleanup(() => closeTerminalTabs(s));
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes("$")), "shell prompt missing");
    const directory = mkdtempSync(join(tmpdir(), "soksak-png-paste-"));
    s.cleanup(() => rmSync(directory, { recursive: true, force: true }));
    const image = join(directory, "one.png");
    writeFileSync(image, PNG);
    execFileSync("osascript", ["-e", `set the clipboard to (read (POSIX file "${image}") as «class PNGf»)`]);

    await s.run("terminal.paste", {}, surface);
    // 긴 경로는 터미널 폭에서 줄바꿈되므로 줄을 이어 읽는다.
    const quoted = /'([^']*\/pasted-image-[^'/]*\.png)'/;
    const pasted = await readScreenUntil(s, surface, (lines) => quoted.test(lines.join("")),
      "the PNG paste did not insert a quoted image path");
    const line = pasted.join("");
    const saved = quoted.exec(line)[1];
    s.cleanup(() => rmSync(saved, { force: true }));
    assert.equal(dirname(saved), join(realpathSync(app.configDir), "clipboard"), `the image is not owned by the configuration: ${line}`);
    assert.deepEqual(readFileSync(saved), PNG, "the saved image differs from the clipboard PNG");
    assert.equal((await s.get("terminal.session", surface)).error, undefined);

    // PNG 로 해석되지 않는 클립보드 바이트는 읽기에서 명시적 오류가 되고 저장되지 않는다.
    execFileSync("osascript", ["-e", "set the clipboard to «data PNGf706E67»"]);
    await assert.rejects(() => s.run("terminal.paste", {}, surface), /PNG decode failed/);
  });

  test(`${app.name}: terminal file drop pastes quoted paths without executing`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    const dropped = "'/tmp/dropped file.txt' '/tmp/quote'\\''name.txt'";
    await s.run("terminal.drop", {
      urls: ["file:///tmp/dropped%20file.txt", "file:///tmp/quote%27name.txt"],
    }, surface);
    const lines = await readScreenUntil(s, surface,
      (screen) => screen.some((line) => line.includes(dropped)),
      "terminal file drop did not paste its quoted paths");
    assert.ok(lines.some((line) => line.includes(dropped)), "file drop payload was not visible in the terminal");
    assert.ok(!lines.some((line) => line.includes("command not found")), "file drop must not execute a command");
  });

  // 진단 빌드의 표면은 플러그인 진단 모듈(diagnostics.json)이 등록한 항목을 갖는다.
  test(`${app.name}: diagnostic terminal entries inject preedit and record terminal input`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    assert.deepEqual(await s.run("terminal.ime.trace", { action: "start" }, surface),
      { enabled: true, overflow: false, entries: [] });
    s.cleanup(() => s.run("terminal.ime.trace", { action: "stop" }, surface));
    await s.run("terminal.compose.update", { text: "글은", selectedRange: { location: 2, length: 0 } }, surface);
    await s.until("terminal.compose", (compose) => compose.text === "글은" && compose.selectedRange?.location === 2,
      "the injected preedit did not reach terminal.compose", { surface });
    await s.run("terminal.compose.update", { text: "" }, surface);
    await s.until("terminal.compose", (compose) => compose.text === "",
      "the empty preedit did not clear terminal.compose", { surface });
    const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
    assert.deepEqual(trace.entries.map((entry) => [entry.kind, entry.input?.type, entry.input?.text]),
      [["terminal-input", "compose", "글은"], ["terminal-input", "compose", ""]]);
  });

  // 세션 오류는 관련 없는 이벤트(테마 확인)가 지우지 않고, 그 오류를 해소하는 이벤트(새 trace)만 지운다.
  test(`${app.name}: a terminal session error stays until the event that resolves it`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await s.until("terminal.session", (state) => Boolean(state?.sessionId && state.theme),
      "terminal session did not report its effective theme", { surface });
    const original = (await s.get("core.settings")).values.mode;
    const other = original === "dark" ? "light" : "dark";
    s.cleanup(() => s.run("core.settings.theme", { name: "midnight", mode: original, scope: "common" }));
    await s.run("terminal.ime.trace", { action: "start" }, surface);
    s.cleanup(() => s.run("terminal.ime.trace", { action: "stop" }, surface));
    // trace 용량은 256 이다. Control-U 는 셸의 입력 줄만 지운다.
    for (let i = 0; i < 257; i++) await s.run("terminal.input", { bytes: "\u0015" }, surface);
    const overflow = "IME diagnostic trace capacity exceeded";
    await s.until("terminal.session", (state) => state.error === overflow,
      "the trace overflow did not reach terminal.session", { surface });
    await s.run("core.settings.theme", { name: "midnight", mode: other, scope: "common" });
    const switched = await s.until("terminal.session", (state) => state.theme === other,
      `terminal did not acknowledge ${other} theme`, { surface });
    assert.equal(switched.error, overflow, "a theme acknowledgement hid the trace overflow");
    await s.run("terminal.ime.trace", { action: "start" }, surface);
    await s.until("terminal.session", (state) => state.error === undefined,
      "a new trace did not resolve the trace overflow", { surface });
  });

  test(`${app.name}: terminal image follows a window resize`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await assertGridFillsPlane(s, "initial terminal resize layout");

    // 터미널 탭을 활성화한다. core.grid 는 상태이므로 상태 읽기로 카드와 탭을 얻는다.
    const grid = await s.get("core.grid");
    const card = grid.cards.find((c) => c.tabs.some((tab) => tab.plugin === "terminal"));
    if (!card) return t.skip("terminal tab not found");
    const terminalTab = card.tabs.find((tab) => tab.plugin === "terminal");

    await s.run("core.tab.select", { tab: terminalTab.id });

    let terminalSurface;
    await s.until(
      "core.surfaces",
      (surfaces) => {
        const terminal = surfaces.find(
          (surf) => surf.visible && surf.plugin === "terminal" &&
            surf.exposes.includes("status terminal.session")
        );
        if (!terminal) return false;
        terminalSurface = terminal.surface;
        return true;
      },
      "terminal surface did not become visible with terminal.session registered"
    );

    await s.until(
      "terminal.session",
      (session) => session && session.sessionId,
      "terminal session did not report sessionId",
      { surface: terminalSurface }
    );
    await setMeasuredBackground(s, terminalSurface);

    // 화면에 글자를 둔다.
    await s.run("terminal.input", { bytes: "echo hi\r" }, terminalSurface);
    await readScreenUntil(
      s,
      terminalSurface,
      (screen) => screen.some((line) => line.trim() === "hi"),
      "terminal did not print hi"
    );

    const before = await s.get("terminal.session", terminalSurface);

    const marker = "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH-IIII-JJJJ-KKKK-LLLL-MMMM-NNNN-OOOO-PPPP";

    // 먼저 좁은 터미널에 긴 논리 행을 출력한다. 화면에 보이는 줄을 보존하는 것만으로는
    // 충분하지 않으므로, 모든 셀의 문자열을 합쳐 잘림이 없는지 확인한다.
    await s.run("host.window.resize", { width: 800, height: 920 });
    await s.until(
      "host.window",
      (w) => w.content.width === 800 && w.content.height > 0,
      "the window did not become narrow"
    );
    await s.until("core.grid", (grid) =>
      grid && Math.round(grid.width) === Math.round(grid.plane.w)
      && Math.round(grid.height) === Math.round(grid.plane.h),
      "the narrow window did not resize the DOM plane");

    const narrow = await s.until(
      "terminal.session",
      (session) => session && !session.error && session.cols < before.cols,
      `terminal session did not become narrow after the window resize: ${JSON.stringify(before)}`,
      { surface: terminalSurface }
    );
    await s.run("terminal.input", { bytes: `printf '${marker}\\n'\r` }, terminalSurface);
    const narrowLines = await readScreenUntil(
      s,
      terminalSurface,
      (screen) => screen.join("").includes(marker),
      "narrow terminal lost characters from the long logical row"
    );
    const narrowMarkerLines = narrowLines.filter((line) => line === marker);
    assert.equal(narrowMarkerLines.length, 0,
      `narrow terminal must wrap the logical row instead of keeping it on one line: ${JSON.stringify(narrowLines)}`);
    assert.ok(narrowLines.some((line, index) =>
      index > 0 && (narrowLines.slice(0, index).join("") + line).includes(marker)),
    "narrow terminal did not preserve the marker across wrapped rows");

    // 다시 넓히면 sidecar의 열 수와 화면의 논리 행이 함께 복원되어야 한다.
    await s.run("host.window.resize", { width: 1500, height: 920 });
    await s.until(
      "host.window",
      (w) => w.content.width === 1500 && w.content.height > 0,
      "the window did not become wide"
    );
    await s.until("core.grid", (grid) =>
      grid && Math.round(grid.width) === Math.round(grid.plane.w)
      && Math.round(grid.height) === Math.round(grid.plane.h),
      "the wide window did not resize the DOM plane");

    // 사이드카의 resize 응답 state 이벤트가 세션 상태에 도달해야 한다.
    // 셀 크기가 빠진 state 이벤트는 플러그인이 오류로 내놓으므로 cols 가 그대로 남는다.
    const after = await s.until(
      "terminal.session",
      (session) =>
        session &&
        !session.error &&
        session.cols > narrow.cols &&
        session.rows > before.rows,
      `terminal session did not grow after the narrow resize: ${JSON.stringify(narrow)}`,
      { surface: terminalSurface }
    );
    assert.equal(after.error, undefined, "resize state event must not set an error");

    const wideLines = await readScreenUntil(
      s,
      terminalSurface,
      (screen) => screen.join("").includes(marker)
      && screen.filter((line) => line === marker).length === 1,
      "wide terminal did not reflow the logical row back to one line"
    );
    assert.ok(wideLines.some((line) => line.includes(marker)),
      "wide terminal does not contain the complete logical row");

    await s.presented();

    // 커진 영역 안에서 그림이 영역을 덮는지 수치로 잰다.
    const terminalRect = await s.rect("terminal.view", undefined, terminalSurface);
    assert.ok(
      terminalRect.width > 0 && terminalRect.height > 0,
      "terminal view rect is empty"
    );

    const capture = await s.request("diagnostics.capture.start", {});
    const { frames: frameDir } = await s.request("diagnostics.capture.stop", {
      after: (await s.presented()).displayed,
    });

    s.cleanup(async () => {
      await closeTerminalTabs(s);
      rmSync(frameDir, { recursive: true, force: true });
    });

    const frameFiles = frames(frameDir);
    assert.ok(frameFiles.length > 0, "no frames were captured");
    const frame = readFrame(frameFiles[frameFiles.length - 1]);

    const BG_COLOR = MEASURED_BACKGROUND;
    const COLOR_TOLERANCE = 10;
    const BRIGHT_TEXT_THRESHOLD = 160;
    const BG_SAMPLE_RATIO_MIN = 0.5;

    // 창 좌표는 point 이고 frame 은 device pixel 이므로 frame 배율을 곱한다.
    const termX = Math.round(terminalRect.x * frame.scale);
    const termY = Math.round(terminalRect.y * frame.scale);
    const termWidth = Math.round(terminalRect.width * frame.scale);
    const termHeight = Math.round(terminalRect.height * frame.scale);

    let bgPixelCount = 0;
    let totalSampleCount = 0;
    let brightTextCount = 0;
    for (let y = termY; y < termY + termHeight; y += 2) {
      for (let x = termX; x < termX + termWidth; x += 2) {
        if (y < 0 || y >= frame.height || x < 0 || x >= frame.width) continue;
        const px = pixel(frame, x, y);
        totalSampleCount++;
        if (px.every((v, i) => Math.abs(v - BG_COLOR[i]) <= COLOR_TOLERANCE)) {
          bgPixelCount++;
        }
        if ((px[0] + px[1] + px[2]) / 3 >= BRIGHT_TEXT_THRESHOLD) brightTextCount++;
      }
    }

    const bgRatio = totalSampleCount > 0 ? bgPixelCount / totalSampleCount : 0;
    assert.ok(
      bgRatio >= BG_SAMPLE_RATIO_MIN,
      `terminal image does not cover the resized region: ${(bgRatio * 100).toFixed(1)}% background over ${termWidth}x${termHeight} (need >= ${(BG_SAMPLE_RATIO_MIN * 100).toFixed(0)}%)`
    );
    assert.ok(
      brightTextCount >= 20,
      `terminal text not visible after resize: ${brightTextCount} bright pixels (need >= 20)`
    );
  });

  test(`${app.name}: multiple terminals keep fixed cells during a divider drag`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => closeTerminalTabs(s));
    const terminals = await ensureTerminals(s, 3);
    assert.ok(terminals.length >= 3, `expected at least three visible terminals, got ${terminals.length}`);
    await s.presented();

    const before = new Map();
    for (const [index, surface] of terminals.entries()) {
      const session = await s.get("terminal.session", surface.surface);
      before.set(surface.surface, { cellWidth: session.cellWidth, cellHeight: session.cellHeight });
      const marker = `DRAG-TEXT-${index}`;
      // 배경을 먼저 바꾼다. 아래의 지우기가 그 출력과 기록을 함께 지운다.
      await setMeasuredBackground(s, surface.surface);
      // 기록도 지운다(ED 3). 이 검사는 네이티브 영역의 정렬을 재며, 기록이 있으면 보이는 스크롤바는 따로 검사한다.
      await s.run("terminal.input", { bytes: `printf '\\033[2J\\033[3J\\033[H${marker}\\n'\r` }, surface.surface);
      await readScreenUntil(
        s,
        surface.surface,
        (screen) => screen[0].trim() === marker,
        `${surface.surface} did not render its marker before the divider drag`
      );
      before.get(surface.surface).marker = marker;
    }
    const beforeGrid = await s.get("core.grid");
    const terminalY = (await s.rect("terminal.view", undefined, terminals[0].surface)).y;
    // 여러 터미널이 있는 상태에서 한 번의 빠른 드래그를 수행한다. 반복 왕복과
    // 프로젝트 복귀는 F1.3에서 별도의 전체 캡처 행렬로 검사한다.
    const terminalCard = beforeGrid.cards.filter((card) => terminals.some((surface) => card.active === surface.surface))
      .sort((a, b) => a.x - b.x)[0];
    assert.ok(terminalCard, "terminal card is missing");
    const result = await drag(t, s, { axis: "x", line: terminalCard.c1, dx: 500, dy: 0, ms: 96, times: 1 }, { capture: true });
    // 녹화는 바뀐 프레임만 담으므로 프레임 수는 화면 재생률을 따른다. 끌기 시간 동안 화면이 그릴 수 있는 프레임의
    // 7/8 이상을 요구한다. 120Hz 에서 192ms 끌기는 이전 기준과 같은 21 프레임이다.
    const { refreshRate } = await s.get("host.window");
    assert.ok(refreshRate > 0, `the window reports no refresh rate: ${refreshRate}`);
    const minimum = Math.ceil(result.asked * refreshRate / 1000 * 7 / 8);
    t.diagnostic(`divider recording frames ${result.count} of at least ${minimum} for ${result.asked}ms at ${refreshRate}Hz`);
    assert.ok(result.count >= minimum,
      `divider recording contained too few frames: ${result.count} of at least ${minimum} for ${result.asked}ms at ${refreshRate}Hz`);
    assert.ok(result.longestGap <= 100, `divider recording dropped a gesture interval: ${result.longestGap}ms`);
    assert.equal(result.late, 0, `divider input arrived late: ${result.late} steps`);
    assert.equal(result.deepest, 0, `divider input queue accumulated ${result.deepest} steps`);

    // 왕복의 끝은 시작 좌표와 같아야 한다. 실제 이동은 각 캡처의 카드 좌표로 검사한다.
    const { displayed } = await s.presented();
    // frame 시각은 host 의 표시 시계(ms)다. 실패 문장에 performance trace 의 벽시계 시각으로 적어 trace 와 맞춘다.
    const clockOffset = Date.now() - displayed;
    const at = (time) => new Date(time + clockOffset).toISOString();
    const host = await s.get("host.window");
    const positions = [];
    let firstGlyph = null;
    for (const [index, file] of frames(result.frameDir).entries()) {
      const frame = readFrame(file);
      const boxes = surfaceBoxes(frame, MEASURED_BACKGROUND);
      const terminalBoxes = boxes.filter((box) =>
        Math.abs(box.row / frame.scale - terminalY) <= 5);
      assert.equal(terminalBoxes.length, terminals.length, `frame ${index}: every terminal must be measurable`);
      positions.push({ time: frame.time,
        position: [...terminalBoxes].sort((a, b) => a.card.l - b.card.l)[1].card.l / frame.scale });
      for (const box of terminalBoxes) {
        assert.ok(box.l > box.card.l && box.r - 1 < box.card.r,
          `frame ${index} at ${at(frame.time)}: terminal ${box.l}..${box.r - 1} invades DOM card ${box.card.l}..${box.card.r}`);
        const scale = frame.scale;
        const leftGap = box.l - box.card.l;
        const rightGap = box.card.r - box.r;
        assert.ok(leftGap >= scale && leftGap <= 2 * scale,
          `frame ${index} at ${at(frame.time)}: terminal left gap is ${leftGap}px; ` +
          `(surface=${box.l}..${box.r}, card=${box.card.l}..${box.card.r}, scale=${scale})`);
        // surfaceBoxes.r는 배타적 좌표이고 span().card.r는 카드의 마지막 픽셀이다.
        // 네이티브 영역은 오른쪽 보더의 안쪽 경계 바로 앞에서 끝나야 한다.
        assert.ok(rightGap >= 0 && rightGap <= 2 * scale,
          `frame ${index} at ${at(frame.time)}: terminal right gap is ${rightGap}px; ` +
          `(surface=${box.l}..${box.r}, card=${box.card.l}..${box.card.r}, scale=${scale})`);
        assert.ok(box.r - box.l >= box.card.r - box.card.l - 4 * scale,
          `frame ${index} at ${at(frame.time)}: terminal native area is narrower than its card`);
        assert.equal(whitePixels(frame, { l: box.l, r: box.r, t: box.t, b: box.b }), 0,
          `frame ${index}: terminal contains white pixels`);
        const metrics = before.values().next().value;
        const shape = glyphShape(frame, { l: box.l, r: box.l + Math.round(metrics.cellWidth * scale),
          t: box.t, b: box.t + Math.round(metrics.cellHeight * scale) });
        firstGlyph ??= shape;
        assert.equal(shape.height, firstGlyph.height,
          `frame ${index}: terminal glyph height changed during drag`);
        assert.ok(Math.abs(shape.width - firstGlyph.width) <= 1,
          `frame ${index}: terminal glyph raster width changed beyond subpixel rounding`);
      }
    }
    // 오래 머문 배치는 모두 녹화에 나와야 한다. 한 번의 표시보다 짧게 머문 위치는 대신될 수 있다.
    assertHeldStatesShown(positions, result.ticks, result.boundary);
    for (const surface of await s.surfaces("terminal")) {
      const session = await s.get("terminal.session", surface.surface);
      const original = before.get(surface.surface);
      await readScreenUntil(
        s,
        surface.surface,
        (screen) => screen.join("").includes(original.marker),
        `${surface.surface} lost terminal text during the divider drag`
      );
      assert.equal(session.cellWidth, original.cellWidth, `${surface.surface} changed terminal cell width`);
      assert.equal(session.cellHeight, original.cellHeight, `${surface.surface} changed terminal cell height`);
      const region = host.regions.find((item) => item.surface === surface.surface);
      assert.ok(region, `${surface.surface} has no native region after divider drag`);
      assert.equal(region.presented.width, Math.round(region.frame.width * region.presented.scale),
        `${surface.surface} raster width does not match its frame after divider drag`);
      assert.equal(region.presented.height, Math.round(region.frame.height * region.presented.scale),
        `${surface.surface} raster height does not match its frame after divider drag`);
    }
  });
}
