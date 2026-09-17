// 캡처가 기록한 프레임 하나를 읽는다.
//
// 프레임은 원시 BGRA 다. 앞에 너비, 높이, 한 줄의 바이트 수(uint32)와 창이 그려진 사각형,
// 콘텐츠 배율, 배율, 표시 시각(float64)이 기록되어 있다. 형식과 인코딩하지 않는 이유는
// native/darwin/src/capture.h 와 capture.m 에 적혀 있다.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HEAD = 12 + 7 * 8;

/**
 * 파일 하나를 { width, height, stride, content, contentScale, scale, time, data } 로 읽는다.
 * content 는 버퍼 안에서 창이 그려진 사각형(버퍼 포인트), time 은 표시 시각(ms)이다.
 *
 * 짧은 파일은 거절한다. 녹화가 멈추는 사이에 쓰이던 프레임은 끝이 잘리고, 잘린
 * 자리를 읽으면 undefined 가 나와 어떤 색 검사에도 걸리지 않는다. 그대로 두면
 * 깨진 프레임을 온전한 프레임으로 처리하게 된다.
 */
export function readFrame(path) {
  const file = readFileSync(path);
  const width = file.readUInt32LE(0);
  const height = file.readUInt32LE(4);
  const stride = file.readUInt32LE(8);
  const info = [0, 1, 2, 3, 4, 5, 6].map((i) => file.readDoubleLE(12 + i * 8));
  const data = file.subarray(HEAD);
  if (data.length < stride * height) {
    throw new Error(`${path} holds ${data.length} bytes, ${stride * height} expected`);
  }
  const [x, y, w, h, contentScale, scale, time] = info;
  return { width, height, stride, content: { x, y, width: w, height: h }, contentScale, scale, time, data };
}

/** 한 폴더의 프레임을 적힌 순서대로. */
export function frames(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".bgra"))
    .sort()
    .map((name) => join(directory, name));
}

/** 한 픽셀의 [r, g, b]. */
export function pixel(frame, x, y) {
  const i = y * frame.stride + x * 4;
  return [frame.data[i + 2], frame.data[i + 1], frame.data[i]];
}
