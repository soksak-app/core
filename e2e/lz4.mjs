// LZ4 RAW 블록을 선언한 크기로 복원하며 잘린 입력과 잘못된 참조를 거부한다.
export function decodeLz4(source, expected) {
  const data = Buffer.alloc(expected);
  let input = 0, output = 0, finished = false;
  function length(base) {
    if (base !== 15) return base;
    let next;
    do {
      if (input >= source.length) throw new Error("LZ4 length extension is incomplete");
      next = source[input++]; base += next;
      if (base > expected) throw new Error("LZ4 length exceeds the declared pixel size");
    } while (next === 255);
    return base;
  }
  while (input < source.length) {
    const token = source[input++];
    const literals = length(token >>> 4);
    if (input + literals > source.length || output + literals > expected) {
      throw new Error("LZ4 literals exceed the block or declared pixel size");
    }
    source.copy(data, output, input, input + literals);
    input += literals; output += literals;
    if (input === source.length) {
      if (expected >= 5 && literals < 5) throw new Error("LZ4 final literals are incomplete");
      finished = true; break;
    }
    if (input + 2 > source.length) throw new Error("LZ4 match offset is incomplete");
    const offset = source.readUInt16LE(input); input += 2;
    if (offset === 0 || offset > output) throw new Error("LZ4 match references unavailable pixels");
    let count = length(token & 15) + 4;
    if (output > expected - 12 || output + count > expected) throw new Error("LZ4 match exceeds the declared pixel size");
    const from = output - offset;
    let available = offset;
    while (count > 0) {
      const copied = Math.min(available, count);
      data.copy(data, output, from, from + copied);
      output += copied; available += copied; count -= copied;
    }
  }
  if (!finished || output !== expected) throw new Error(`LZ4 restores ${output} bytes, ${expected} expected`);
  return data;
}
