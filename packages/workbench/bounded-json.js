// The bound on text that an event carries (docs/spec/logging.md#bounds). A value is cut while it is serialized: the walk
// stops as soon as the text is longer than the bound, so the cost does not depend on the size of the value, and JSON.stringify
// is never called on a whole value.

const encoder = new TextEncoder();

/** The first characters of text that take at most `limit` bytes in UTF-8, and whether text had more. A character is never split. */
export function cutBytes(text, limit) {
  // A UTF-16 unit takes at most 3 bytes in UTF-8, so a text of at most limit / 3 units needs no measure.
  if (text.length * 3 <= limit) return { text, truncated: false };
  // A unit takes at least one byte, so only the first `limit` units can fit.
  const { read } = encoder.encodeInto(text.length > limit ? text.slice(0, limit) : text, new Uint8Array(limit));
  return { text: text.slice(0, read), truncated: read < text.length };
}

/** The number of bytes of text in UTF-8; a lone surrogate counts as the 3 bytes of its replacement character. */
export function byteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

// Raised inside the walk when the text is longer than the bound.
const FULL = Symbol("full");

/**
 * The JSON text of value, as JSON.stringify writes it, cut to at most `limit` UTF-8 bytes, and whether it was cut. Text that fits
 * is equal to JSON.stringify(value); a value that JSON.stringify refuses (a cycle, a BigInt) throws the same TypeError. The text
 * is undefined for a value that JSON has no text for (undefined, a function, a symbol).
 */
export function boundedJson(value, limit) {
  const parts = [];
  let length = 0;
  const stack = [];
  const add = (text) => {
    parts.push(text);
    length += text.length;
    if (length > limit) throw FULL;
  };
  const jsonValue = (holder, key) => {
    let item = holder[key];
    if (item !== null && (typeof item === "object" || typeof item === "bigint") && typeof item.toJSON === "function") item = item.toJSON(key);
    if (item instanceof Number) item = Number(item);
    else if (item instanceof String) item = String(item);
    else if (item instanceof Boolean || (typeof BigInt === "function" && item instanceof BigInt)) item = item.valueOf();
    return item;
  };
  const walk = (item) => {
    switch (typeof item) {
      case "string":
        // The escaped text is at least as long as the string, so a string longer than the room left is cut before it is escaped.
        if (item.length > limit - length) {
          add(JSON.stringify(item.slice(0, limit - length + 1)).slice(0, -1));
          throw FULL;
        }
        add(JSON.stringify(item));
        return;
      case "number":
        add(Number.isFinite(item) ? String(item) : "null");
        return;
      case "boolean":
        add(item ? "true" : "false");
        return;
      case "bigint":
        throw new TypeError("Do not know how to serialize a BigInt");
      default:
        if (item === null) {
          add("null");
          return;
        }
    }
    if (stack.includes(item)) throw new TypeError("Converting circular structure to JSON");
    stack.push(item);
    if (Array.isArray(item)) {
      add("[");
      for (let i = 0; i < item.length; i += 1) {
        if (i > 0) add(",");
        const element = jsonValue(item, String(i));
        if (element === undefined || typeof element === "function" || typeof element === "symbol") add("null");
        else walk(element);
      }
      add("]");
    } else {
      add("{");
      let first = true;
      for (const name of Object.keys(item)) {
        const member = jsonValue(item, name);
        if (member === undefined || typeof member === "function" || typeof member === "symbol") continue;
        add(`${first ? "" : ","}${JSON.stringify(name)}:`);
        first = false;
        walk(member);
      }
      add("}");
    }
    stack.pop();
  };
  const top = jsonValue({ "": value }, "");
  if (top === undefined || typeof top === "function" || typeof top === "symbol") return { text: undefined, truncated: false };
  try {
    walk(top);
  } catch (error) {
    if (error !== FULL) throw error;
    return { ...cutBytes(parts.join(""), limit), truncated: true };
  }
  const text = parts.join("");
  return cutBytes(text, limit);
}
