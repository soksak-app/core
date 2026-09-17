// 창을 최대화하고 되돌리는 과정을 녹화해, 끝난 뒤 앱 배치가 창 크기와 맞는지 검사하고 변경 중 배치가
// 창보다 늦은 프레임 수를 보고한다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";
import { frames, readFrame } from "./frame.mjs";

/**
 * 배치의 오른쪽·아래 끝과 창 끝 사이의 여백이 기준과 이만큼(pt) 넘게 다른 프레임은 배치가 창보다 늦은 프레임이다.
 * 커질 때는 여백이 벌어지고, 줄어들 때는 이전 배치가 창 밖으로 잘려 여백이 사라진다.
 */
const LAG = 12;

/** 카드 테두리와 글자보다 어두운 밝기. 창 배경과 빈 영역은 이보다 어둡다. */
const BRIGHT = 70;

/**
 * 프레임에서 창 크기와 밝은 픽셀이 있는 가장 오른쪽 열·가장 아래 행을 창 포인트로 잰다.
 * 버퍼는 녹화 시작 크기로 고정되고, 커진 창은 contentScale 만큼 줄어 담긴다.
 */
function measure(frame) {
  const ratio = frame.contentScale * frame.scale;
  const width = Math.floor(frame.content.width * frame.scale);
  const height = Math.floor(frame.content.height * frame.scale);
  const bright = (x, y) => {
    const i = y * frame.stride + x * 4;
    return Math.max(frame.data[i], frame.data[i + 1], frame.data[i + 2]) > BRIGHT;
  };
  let right = -1;
  for (let x = width - 1; x >= 0 && right < 0; x--) {
    for (let y = 0; y < height; y++) if (bright(x, y)) { right = x; break; }
  }
  let bottom = -1;
  for (let y = height - 1; y >= 0 && bottom < 0; y--) {
    for (let x = 0; x < width; x++) if (bright(x, y)) { bottom = y; break; }
  }
  return {
    time: frame.time,
    window: { width: frame.content.width / frame.contentScale, height: frame.content.height / frame.contentScale },
    gap: { x: frame.content.width / frame.contentScale - (right + 1) / ratio,
      y: frame.content.height / frame.contentScale - (bottom + 1) / ratio },
  };
}

/** 창 크기를 바꾸는 change 를 녹화하고, 배치가 새 크기로 표시될 때까지의 프레임을 잰다. */
const right = (w) => Math.max(...w.surfaces.filter((x) => x.visible).map((x) => x.frame.x + x.frame.width));

/** 창 오른쪽 끝과 가장 오른쪽 표면 사이의 거리. 배치는 창 크기와 관계없이 이 거리를 유지한다. */
const margin = (w) => w.content.width - right(w);

async function record(s, change, sized) {
  const kept = margin(await s.get("host.window"));
  const { frames: directory } = await s.request("diagnostics.capture.start");
  // 녹화는 창 크기의 프레임을 초당 60 장까지 담으므로 측정한 뒤 바로 지운다.
  try {
    // 녹화는 이 표시 시각의 화면까지 담는다. 앱이 커밋한 화면은 표시 대기가 끝난 뒤에 표시된다.
    let displayed = 0;
    try {
      await change();
      // 창이 새 크기에 도달하고 표면이 그 크기의 배치로 옮겨진 뒤 그 배치가 표시될 때까지 기다린다.
      await s.until("host.window", (w) => sized(w) && Math.abs(margin(w) - kept) < 1,
        "the surfaces did not follow the window");
      ({ displayed } = await s.presented());
    } finally {
      await s.request("diagnostics.capture.stop", { after: displayed });
    }
    return { displayed, measured: frames(directory).map((path) => measure(readFrame(path))) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * 변경이 끝나 표시된 마지막 프레임의 배치가 창 크기와 맞는지 확인하고, 변경 중 배치가 창보다 늦은
 * 프레임 수를 보고한다. 창 프레임과 WebKit 내용은 따로 표시되므로(WebKit/WebKit#72971,
 * tauri-apps/tao#1207) 변경 중의 늦은 프레임은 측정값으로만 남긴다.
 */
function assertSettled(t, { displayed, measured }, label) {
  assert.ok(measured.length > 1, `${label}: only ${measured.length} frames were recorded`);
  const [first] = measured;
  const last = measured.at(-1);
  const tail = measured.slice(-5).map((m) =>
    `${(m.time - first.time).toFixed(0)}ms ${m.window.width.toFixed(0)}×${m.window.height.toFixed(0)} gap ${m.gap.x.toFixed(0)},${m.gap.y.toFixed(0)}`);
  const shown = `presented for display at ${(displayed - first.time).toFixed(0)}ms`;
  assert.ok(Math.abs(last.window.width - first.window.width) > 100,
    `${label}: the recording did not include the resized window (${first.window.width} → ${last.window.width}; ` +
    `${shown}; last frames ${tail.join(", ")})`);
  const off = (m) => Math.abs(m.gap.x - first.gap.x) > LAG || Math.abs(m.gap.y - first.gap.y) > LAG;
  const late = measured.filter(off);
  const took = late.length ? late.at(-1).time - first.time : 0;
  t.diagnostic(`${label}: ${late.length} of ${measured.length} frames show the layout behind the window, the last at ${took.toFixed(0)}ms`);
  assert.ok(!off(last), `${label}: the settled frame shows the layout behind the window ` +
    `(window ${last.window.width.toFixed(0)}×${last.window.height.toFixed(0)}, gap ${last.gap.x.toFixed(0)},${last.gap.y.toFixed(0)}, ` +
    `base gap ${first.gap.x.toFixed(0)},${first.gap.y.toFixed(0)}; ${shown}; last frames ${tail.join(", ")})`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: maximising and restoring settle with the layout at the window size`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const before = (await s.get("host.window")).frame;
    // 창이 있는 화면의 사용 가능 영역이 최대화한 창의 프레임이다.
    const screen = (await s.get("host.screens")).find((x) => before.x >= x.x && before.x < x.x + x.width
      && before.y >= x.y && before.y < x.y + x.height);
    const same = (a, b) => ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) < 1);
    let maximised = false;
    s.cleanup(async () => {
      if (!maximised) return;
      await s.run("host.window.maximize", { on: false });
      await s.until("host.window", (w) => w.frame.width === before.width && w.frame.height === before.height,
        "the window did not return to its size");
      await s.presented();
    });

    const grown = await record(s, async () => {
      maximised = true;
      await s.run("host.window.maximize", { on: true });
    }, (w) => same(w.frame, screen.visible));
    assertSettled(t, grown, "maximising");

    const shrunk = await record(s, () => s.run("host.window.maximize", { on: false }),
      (w) => same(w.frame, before));
    maximised = false;
    assertSettled(t, shrunk, "restoring");
  });
}
