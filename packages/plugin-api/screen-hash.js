// The hash of a terminal screen (docs/spec/replay.md#screen-hash). A sidecar stores the hash of each screen it produces and a
// page stores the hash of each screen it draws; a replay compares them. `screenBytes` builds the canonical bytes and
// `screenHash` is their SHA-256 as 64 lowercase hexadecimal characters. The golden vectors in
// packages/log-contract/fixtures/replay/screen-hash.json fix both for every language.
//
// A screen is {rows, cols, cursor: {row, col, visible}, cells}. `cells` holds rows × cols cells in row-major order, each
// {grapheme, width, fg, bg, attributes}. A color is null (default), an integer from 0 to 255 (indexed) or "#rrggbb" in lowercase.

const MAGIC = "SKSCR1";
const COLOR = /^#[0-9a-f]{6}$/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function refuse(reason) {
  throw new Error(`screen hash: ${reason}`);
}

function shown(value) {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    refuse(`${name} must be an integer from ${min} to ${max}, found ${shown(value)}`);
  }
  return value;
}

function colorBytes(name, color) {
  if (color === null) return [0, 0, 0, 0];
  if (Number.isInteger(color) && color >= 0 && color <= 255) return [1, 0, 0, color];
  if (typeof color === "string" && COLOR.test(color)) {
    return [2, parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
  }
  return refuse(`${name} must be null, an integer from 0 to 255 or "#rrggbb", found ${shown(color)}`);
}

/** The canonical bytes of a screen as a Uint8Array. Throws an error that names the member when the screen is malformed. */
export function screenBytes(screen) {
  if (!isObject(screen)) refuse(`screen must be an object, found ${shown(screen)}`);
  const { rows, cols, cursor, cells } = screen;
  for (const [name, value] of [["rows", rows], ["cols", cols]]) {
    if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) refuse(`${name} must be a positive integer, found ${shown(value)}`);
  }
  if (!isObject(cursor)) refuse(`cursor must be an object, found ${shown(cursor)}`);
  if (typeof cursor.visible !== "boolean") refuse(`cursor.visible must be true or false, found ${shown(cursor.visible)}`);
  integer("cursor.row", cursor.row, 0, rows - 1);
  integer("cursor.col", cursor.col, 0, cols - 1);
  if (!Array.isArray(cells) || cells.length !== rows * cols) {
    refuse(`cells must hold ${rows * cols} cells (rows ${rows} × cols ${cols}), found ${Array.isArray(cells) ? cells.length : shown(cells)}`);
  }
  const encoder = new TextEncoder();
  const parts = [];
  let size = 0;
  const push = (bytes) => {
    parts.push(bytes);
    size += bytes.length;
  };
  const u32 = (value) => new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
  push(encoder.encode(MAGIC));
  push(u32(rows));
  push(u32(cols));
  push(new Uint8Array([cursor.visible ? 1 : 0]));
  push(u32(cursor.row));
  push(u32(cursor.col));
  cells.forEach((cell, index) => {
    const at = `cells[${index}]`;
    if (!isObject(cell)) refuse(`${at} must be an object, found ${shown(cell)}`);
    if (typeof cell.grapheme !== "string") refuse(`${at}.grapheme must be a string, found ${shown(cell.grapheme)}`);
    if (LONE_SURROGATE.test(cell.grapheme)) refuse(`${at}.grapheme must be well-formed Unicode`);
    if (cell.width !== 0 && cell.width !== 1 && cell.width !== 2) refuse(`${at}.width must be 0, 1 or 2, found ${shown(cell.width)}`);
    const grapheme = encoder.encode(cell.grapheme);
    push(u32(grapheme.length));
    push(grapheme);
    push(new Uint8Array([cell.width, ...colorBytes(`${at}.fg`, cell.fg), ...colorBytes(`${at}.bg`, cell.bg), integer(`${at}.attributes`, cell.attributes, 0, 255)]));
  });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** The screen hash: the SHA-256 of `screenBytes(screen)` as 64 lowercase hexadecimal characters. */
export async function screenHash(screen) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", screenBytes(screen));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function messageRefuse(reason) {
  throw new Error(`screen message: ${reason}`);
}

function resolvedColor(name, color) {
  if (color === null || Number.isInteger(color) || typeof color === "string") return color;
  return messageRefuse(`${name} must be a resolved color (null, an integer from 0 to 255 or "#rrggbb"), found ${shown(color)}`);
}

/**
 * The screen that `screenHash` takes, from a `screen` message of a sidecar (docs/spec/terminal-runtime.md#screen-message).
 * The message carries `sequence` and every member of the screen, with each cell's `fg` and `bg` resolved; the members that the
 * hash does not cover (`link`, the cursor shape and focus) are left out. A message that lacks a member throws an error that names
 * the member; the ranges of the values are checked by the screen hash. The page stores `message.sequence` with the hash.
 */
export function screenFromMessage(message) {
  if (!isObject(message)) messageRefuse(`message must be an object, found ${shown(message)}`);
  if (message.event !== "screen") messageRefuse(`event must be "screen", found ${shown(message.event)}`);
  if (!Number.isInteger(message.sequence) || message.sequence < 1) {
    messageRefuse(`sequence must be an integer from 1, found ${shown(message.sequence)}`);
  }
  if (!isObject(message.cursor)) messageRefuse(`cursor must be an object, found ${shown(message.cursor)}`);
  if (!Array.isArray(message.cells)) messageRefuse(`cells must be an array, found ${shown(message.cells)}`);
  const cells = message.cells.map((cell, index) => {
    const at = `cells[${index}]`;
    if (!isObject(cell)) messageRefuse(`${at} must be an object, found ${shown(cell)}`);
    const fg = resolvedColor(`${at}.fg`, cell.fg);
    const bg = resolvedColor(`${at}.bg`, cell.bg);
    if (!Number.isInteger(cell.attributes)) messageRefuse(`${at}.attributes must be an integer from 0 to 255, found ${shown(cell.attributes)}`);
    return { grapheme: cell.grapheme, width: cell.width, fg, bg, attributes: cell.attributes };
  });
  const { rows, cols } = message;
  const { row, col, visible } = message.cursor;
  const screen = { rows, cols, cursor: { row, col, visible }, cells };
  screenBytes(screen);
  return screen;
}
