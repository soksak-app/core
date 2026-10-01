// 사방 손잡이 녹화의 모든 프레임에서 경계 좌표를 검사한다.
import assert from "node:assert/strict";
import { pixel } from "./frame.mjs";
const sign = (side) => (side === "top" || side === "left" ? 1 : -1);
function border(frame, side, at, cross) {
  const ratio = frame.scale * frame.contentScale;
  const vertical = side === "left" || side === "right";
  const offsets = [-12, -6, 0, 6, 12];
  return offsets.every((offset) => {
    const point = vertical ? [at, cross + offset] : [cross + offset, at];
    const rgb = pixel(frame, Math.floor(point[0] * ratio), Math.floor(point[1] * ratio));
    return rgb.every((value, index) => Math.abs(value - [43, 46, 61][index]) <= 3);
  });
}
export function recordedEdges(captured, side, initial, cross, poses, layouts) {
  assert.ok(Array.isArray(poses), "gesture recording requires a pose timeline");
  assert.ok(Array.isArray(layouts), "gesture recording requires a layout timeline");
  return captured.map((frame, frameIndex) => {
    const matches = [];
    for (let step = -2; step <= 42; step += 0.5) {
      const coordinate = initial + sign(side) * step;
      if (border(frame, side, coordinate, cross)) matches.push(coordinate);
    }
    if (!matches.length) {
      const ratio = frame.scale * frame.contentScale,
        vertical = side === "left" || side === "right";
      const samples = [];
      for (let step = -2; step <= 42; step += 0.5) {
        const at = initial + sign(side) * step;
        const colors = [-12, -6, 0, 6, 12].map((offset) =>
          pixel(
            frame,
            Math.floor((vertical ? at : cross + offset) * ratio),
            Math.floor((vertical ? cross + offset : at) * ratio),
          ),
        );
        samples.push({ at, colors });
      }
      const axisBorders = [];
      const extent = (vertical ? frame.width : frame.height) / ratio;
      for (let at = 0; at < extent; at += 0.5) if (border(frame, side, at, cross)) axisBorders.push(at);
      assert.fail(
        `${side}: frame has no measured sidebar border ${JSON.stringify({ frameIndex, frameCount: captured.length, time: frame.time, width: frame.width, height: frame.height, content: frame.content, scale: frame.scale, contentScale: frame.contentScale, initial, cross, poses, layouts, axisBorders, samples })}`,
      );
    }
    return matches;
  });
}
