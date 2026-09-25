// 창 캡처(diagnostics.capture.still)가 남긴 PNG 를 읽는다. 8비트 RGB 와 RGBA, 비월 주사 없는 파일만 받는다.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/** 파일 하나를 { width, height, pixel(x, y) } 로 읽는다. pixel 은 [r, g, b] 다. */
export function readPng(path) {
  const file = readFileSync(path);
  if (file.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} is not a PNG`);
  let at = 8;
  let width, height, channels;
  const data = [];
  while (at < file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString("latin1", at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) {
        throw new Error(`${path}: depth ${depth}, color type ${color}, interlace ${interlace} is not read`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      data.push(body);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`${path}: unknown filter ${filter} on line ${y}`);
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return {
    width, height,
    pixel(x, y) {
      const at = y * stride + x * channels;
      return [pixels[at], pixels[at + 1], pixels[at + 2]];
    },
  };
}

/** 두 색의 가장 큰 채널 차이. */
export const distance = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));
