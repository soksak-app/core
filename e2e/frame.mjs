// 캡처가 기록한 프레임 하나를 읽는다.
//
// 프레임은 원시 BGRA 다. 앞에 너비, 높이, 한 줄의 바이트 수가 32비트로 기록되어 있다.
// 인코딩하지 않는 이유는 캡처 쪽에 적혀 있다.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

/**
 * 파일 하나를 { width, height, stride, data } 로 읽는다.
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
  const data = file.subarray(12);
  if (data.length < stride * height) {
    throw new Error(`${path} holds ${data.length} bytes, ${stride * height} expected`);
  }
  return { width, height, stride, data };
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

/** 프레임 하나를 PNG 로 저장한다. 검사가 실패한 프레임을 남길 때만 호출한다. */
export function writePNG(frame, path) {
  const raw = Buffer.alloc(frame.height * (frame.width * 3 + 1));
  let at = 0;
  for (let y = 0; y < frame.height; y++) {
    raw[at++] = 0;
    for (let x = 0; x < frame.width; x++) {
      const i = y * frame.stride + x * 4;
      raw[at++] = frame.data[i + 2];
      raw[at++] = frame.data[i + 1];
      raw[at++] = frame.data[i];
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(frame.width, 0);
  head.writeUInt32BE(frame.height, 4);
  head[8] = 8;
  head[9] = 2;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

function chunk(kind, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(kind, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
