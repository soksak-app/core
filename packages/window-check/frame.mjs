// 캡처가 기록한 프레임 하나를 읽는다.
//
// 프레임은 메타데이터와 체크섬이 있는 LZ4 블록으로 모든 BGRA 바이트를 복원한다.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { decodeLz4 } from "./lz4.mjs";

const HEAD = 80;

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
  if (file.length < HEAD || !file.subarray(68, 72).equals(Buffer.from("LZ4B"))) {
    throw new Error(`${path} has no complete LZ4 frame header`);
  }
  const width = file.readUInt32LE(0);
  const height = file.readUInt32LE(4);
  const stride = file.readUInt32LE(8);
  const info = [0, 1, 2, 3, 4, 5, 6].map((i) => file.readDoubleLE(12 + i * 8));
  if (width === 0 || height === 0 || stride < width * 4 || !Number.isSafeInteger(stride * height)) {
    throw new Error(`${path} has invalid pixel dimensions or row stride`);
  }
  const encoded = file.readUInt32LE(72);
  if (encoded === 0 || file.length !== HEAD + encoded) throw new Error(`${path} has an incomplete or extra compressed block`);
  const data = decodeLz4(file.subarray(HEAD), stride * height);
  if (crc32(data) !== file.readUInt32LE(76)) throw new Error(`${path} has an invalid pixel checksum`);
  const [x, y, w, h, contentScale, scale, time] = info;
  return { width, height, stride, content: { x, y, width: w, height: h }, contentScale, scale, time, data };
}

/** 한 폴더의 프레임을 적힌 순서대로. */
export function frames(directory) {
  // 한 process 의 녹화는 frame 번호를 이어서 매기므로 번호가 9999 를 넘으면 이름의 문자열 순서가 frame 순서와 다르다.
  // 이름의 번호로 정렬한다(docs/spec/endpoint.md).
  const number = (name) => {
    const match = /^frame-(\d+)\.bgra$/.exec(name);
    if (!match) throw new Error(`recording ${directory} has an unexpected frame file ${name}`);
    return Number(match[1]);
  };
  return readdirSync(directory)
    .filter((name) => name.endsWith(".bgra"))
    .sort((a, b) => number(a) - number(b))
    .map((name) => join(directory, name));
}

/** 한 픽셀의 [r, g, b]. */
export function pixel(frame, x, y) {
  const i = y * frame.stride + x * 4;
  return [frame.data[i + 2], frame.data[i + 1], frame.data[i]];
}
