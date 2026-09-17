// 실제 화면 배율과 네이티브 입력으로 표면의 문서 좌표를 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, fresh as prepare, halfPointRow, open } from "./app.mjs";

/**
 * 표시 완료 후 네이티브 표면, DOM 슬롯, 표면 문서의 배율과 크기가 일치할 때까지 기다리고
 * 표면의 창 좌표 프레임을 반환한다.
 */
async function geometry(s, surface, scale) {
  const content = (await s.get("host.window")).content;
  await s.until("core.window.document", (doc) => doc.width === content.width && doc.height === content.height,
    `the main document did not take the content size ${content.width}×${content.height}`);
  await s.until("core.surfaces", (list) => {
    const placed = list.find((x) => x.surface === surface);
    return placed && ["x", "y", "w", "h"].every((k) => placed.applied[k] === placed.declared[k]);
  }, "the host did not apply the declared surface frame");
  await s.presented();
  const state = await s.get("host.window");
  const frame = state.surfaces.find((x) => x.id === surface).frame;
  assert.equal(state.scale, scale, "the window must report the expected backing scale");
  const main = await s.until("core.window.document", (doc) => doc.scale === scale,
    `the main document did not take scale ${scale}`);
  const slot = (await s.surfaces()).find((x) => x.surface === surface).declared;
  assert.deepEqual([frame.x, frame.y, frame.width, frame.height], [slot.x, slot.y, slot.w, slot.h],
    `the native surface must fill its DOM slot at scale ${main.scale}`);
  await s.until("core.surface.document", (doc) => doc.scale === scale
    && doc.body.width === frame.width && doc.body.height === frame.height
    && doc.viewport.width === frame.width && doc.viewport.height === frame.height,
  `the surface document did not match ${JSON.stringify(frame)} at scale ${scale}`, { surface });
  return { state, frame };
}

/** 표면의 마지막 기기 픽셀 행을 네이티브 입력으로 누르고, 문서가 받은 좌표를 확인한다. */
async function clickLastPixel(s, surface, scale) {
  const { state, frame } = await geometry(s, surface, scale);
  const x = frame.width / 2, y = frame.height - 0.5 / scale;
  const point = { x: frame.x + x, y: frame.y + y };
  assert.deepEqual(await s.run("host.hit", point), { kind: "surface", surface });
  const seen = (await s.get("core.surface.input", surface)).at(-1)?.sequence ?? 0;
  const fresh = (list) => list.filter((e) => e.sequence > seen);
  await s.pointer(point.x, point.y, "down");
  const down = await s.until("core.surface.input", (events) => fresh(events).some((e) => e.type === "pointerdown"),
    "the final device pixel did not receive pointerdown", { surface });
  await s.pointer(point.x, point.y, "up");
  const events = await s.until("core.surface.input", (list) => fresh(list).some((e) => e.type === "click"),
    "the final device pixel did not receive click", { surface });
  for (const [type, tolerance, list] of [["pointerdown", 0.001, down], ["click", 1, events]]) {
    const event = fresh(list).find((e) => e.type === type);
    assert.equal(event.trusted, true, `${type} must come through native event handling`);
    assert.ok(Math.abs(event.x - x) < tolerance && Math.abs(event.y - y) < tolerance,
      `native input coordinates changed: expected ${x},${y}, received ${event.x},${event.y} for ${type}`);
  }
  assert.equal((await s.get("host.window")).active, state.active, "native input must not change application activation");
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: resizing preserves document geometry and native input`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    const terminal = await prepare(s);
    const { scale } = await s.get("host.window");
    await clickLastPixel(s, terminal.surface, scale);
    await s.run("host.window.resize", { width: 997, height: 647 });
    await s.until("host.window", (w) => w.content.width === 997 && w.content.height === 647, "the window did not resize");
    await clickLastPixel(s, terminal.surface, scale);
  });

  test(`${app.name}: display-scale changes preserve document geometry and native input`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    const initial = await s.get("host.window");
    const screens = await s.get("host.screens");
    const other = screens.find((screen) => screen.scale !== initial.scale);
    if (!other) return t.skip("two displays with different scale factors are required");
    const terminal = await prepare(s);
    s.cleanup(() => s.run("host.window.move", { x: initial.frame.x, y: initial.frame.y }));
    await halfPointRow(s);
    await clickLastPixel(s, terminal.surface, initial.scale);
    await s.run("host.window.move", { x: other.x + 20, y: other.y + 20 });
    await clickLastPixel(s, terminal.surface, other.scale);
    await s.run("host.window.move", { x: initial.frame.x, y: initial.frame.y });
    await clickLastPixel(s, terminal.surface, initial.scale);
  });
}
