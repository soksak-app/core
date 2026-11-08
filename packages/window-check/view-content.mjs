// Reads the shown content of a view through a content read that the view exposes in its own namespace and that the check names, and
// checks that the host presents the document region that shows it (docs/spec/verification.md#coverage-and-evidence).
import assert from "node:assert/strict";
import { normalizeViewText } from "./view-metrics.mjs";

/** Copies one applied view's exact opaque BGRA crop without resizing or changing channels. */
export function cropViewPixels(frame, rect) {
  assert.ok(frame.data instanceof Uint8Array && frame.data.length === frame.stride * frame.height,
    "capture pixel storage does not match its declared stride and height");
  const ratio = frame.scale * frame.contentScale;
  assert.ok([ratio, rect.x, rect.y, rect.w, rect.h, frame.content.x, frame.content.y].every(Number.isFinite)
    && ratio > 0 && rect.w > 0 && rect.h > 0, "invalid captured view geometry");
  const x = Math.floor(frame.content.x * frame.scale + rect.x * ratio);
  const y = Math.floor(frame.content.y * frame.scale + rect.y * ratio);
  const width = Math.ceil(frame.content.x * frame.scale + (rect.x + rect.w) * ratio) - x;
  const height = Math.ceil(frame.content.y * frame.scale + (rect.y + rect.h) * ratio) - y;
  assert.ok(x >= 0 && y >= 0 && x + width <= frame.width && y + height <= frame.height,
    "the applied view crop lies outside its recorded frame");
  assert.ok(width * height * 4 <= 64 * 1024 * 1024, "the view crop exceeds 64 MiB");
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    data.set(frame.data.subarray((y + row) * frame.stride + x * 4,
      (y + row) * frame.stride + (x + width) * 4), row * width * 4);
  }
  return { width, height, data };
}

/** The visible document region `document` of surface in host.window, or a failure that names what it holds. */
async function visibleDocument(s, surface, document) {
  const host = await s.get("host.window");
  const row = host.documents.find((item) => item.surface === surface && item.document === document);
  assert.ok(row?.visible && row.frame.width > 0 && row.frame.height > 0,
    `${surface} shows no document region ${JSON.stringify(document)}: ${JSON.stringify(row)}`);
  return row;
}

/**
 * The text that the view of surface shows, the answer of the content read `command` that the view exposes in its own namespace and
 * that the check names. The view shows it in its visible document region `document` (the root document "" by default); the caller
 * waits for the presentation of the window (host.window.presented) after this read. An answer that is not text is an error.
 */
export async function readViewContent(s, surface, { command, document = "" }) {
  assert.ok(typeof command === "string" && command.length > 0, `the content read of ${surface} names no command`);
  await visibleDocument(s, surface, document);
  const value = await s.run(command, {}, surface);
  assert.equal(typeof value, "string", `${command} of ${surface} answered no text: ${JSON.stringify(value)}`);
  return value;
}

/**
 * The proof of a content check of a measurement, {method: "value", expected, actual}, after checking that the content text
 * actual that a check read holds expected. owner names the view in a failure.
 */
export function valueProof(expected, actual, owner = "the view") {
  assert.ok(typeof expected === "string" && normalizeViewText(expected).length > 0, "view content requires nonempty expected text");
  assert.equal(typeof actual, "string", `${owner} content is not text: ${JSON.stringify(actual)}`);
  assert.ok(normalizeViewText(actual).includes(normalizeViewText(expected)),
    `${owner} does not show ${JSON.stringify(expected)}: ${JSON.stringify(actual)}`);
  return { method: "value", expected, actual };
}

/** Reads the content of surface through `read` (readViewContent) and returns the proof that it holds expected (valueProof). */
export async function viewContentProof(s, surface, expected, read) {
  return valueProof(expected, await readViewContent(s, surface, read), `${read.command} ${surface}`);
}
