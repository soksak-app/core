// Frame form: a 4-byte big-endian length followed by a UTF-8 JSON body.

export const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

const HEADER_LENGTH = 4;

// Serializes an object to JSON and prepends the length header.
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

// Collects fragmented input and returns objects in units of complete frames.
export class FrameReader {
  #chunks = [];
  #buffered = 0;

  // Appends a chunk and yields the completed objects in order.
  *push(chunk) {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
    }
    while (this.#buffered >= HEADER_LENGTH) {
      const buffer = this.#flatten();
      const length = buffer.readUInt32BE(0);
      // Checks the length before the body is received.
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

  // The number of remaining bytes of an incomplete frame.
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
