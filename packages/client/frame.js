// 프레임 형식: 4바이트 빅엔디언 길이 + UTF-8 JSON 본문.

export const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

const HEADER_LENGTH = 4;

// 객체를 JSON으로 직렬화하고 길이 헤더를 붙인다.
export function encodeFrame(object) {
  const body = Buffer.from(JSON.stringify(object), "utf8");
  if (body.length > MAX_FRAME_LENGTH) {
    throw new RangeError(`Frame length ${body.length} exceeds limit ${MAX_FRAME_LENGTH}`);
  }
  const frame = Buffer.allocUnsafe(HEADER_LENGTH + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, HEADER_LENGTH);
  return frame;
}

// 조각난 입력을 모아 완성된 프레임 단위로 객체를 반환한다.
export class FrameReader {
  #chunks = [];
  #buffered = 0;

  // 청크를 추가하고 완성된 객체를 순서대로 산출한다.
  *push(chunk) {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
    }
    while (this.#buffered >= HEADER_LENGTH) {
      const buffer = this.#flatten();
      const length = buffer.readUInt32BE(0);
      // 본문 수신 전에 길이를 검사한다.
      if (length > MAX_FRAME_LENGTH) {
        throw new RangeError(`Frame length ${length} exceeds limit ${MAX_FRAME_LENGTH}`);
      }
      if (buffer.length < HEADER_LENGTH + length) return;
      const text = buffer.toString("utf8", HEADER_LENGTH, HEADER_LENGTH + length);
      const rest = buffer.subarray(HEADER_LENGTH + length);
      this.#chunks = rest.length > 0 ? [rest] : [];
      this.#buffered = rest.length;
      let value;
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new SyntaxError(`Invalid JSON frame: ${error.message}`);
      }
      yield value;
    }
  }

  // 남아 있는 미완성 바이트 수.
  get pending() {
    return this.#buffered;
  }

  #flatten() {
    if (this.#chunks.length > 1) {
      this.#chunks = [Buffer.concat(this.#chunks, this.#buffered)];
    }
    return this.#chunks[0];
  }
}
