// Reads and writes every item of a pasteboard by format. The pasteboard is the general pasteboard of the person unless a name
// selects a named pasteboard. The harness saves the general pasteboard for each window check and restores it when the check
// ends (open in app.mjs); a test of the harness itself names its own pasteboard and releases it, so it never touches the
// pasteboard of the person.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs a script with the JavaScript of osascript and returns the JSON result.
function jxa(body) {
  const script = `ObjC.import("AppKit");
function run(argv) { const input = JSON.parse(argv[0]); ${body} }`;
  return (input = {}) => {
    const output = execFileSync("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(input)],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return output.trim() === "" ? null : JSON.parse(output);
  };
}

// The JavaScript that selects the pasteboard of input.name; a null name is the general pasteboard.
const selectBoard = "const board = input.name === null ? $.NSPasteboard.generalPasteboard : $.NSPasteboard.pasteboardWithName(input.name);";

const readItems = jxa(`
${selectBoard}
const items = [];
const unreadable = [];
const list = board.pasteboardItems;
for (let i = 0; i < list.count; i++) {
  const item = list.objectAtIndex(i);
  const entry = {};
  const missing = [];
  const types = item.types;
  for (let k = 0; k < types.count; k++) {
    const type = types.objectAtIndex(k).js;
    const data = item.dataForType(type);
    if (data.isNil()) missing.push(type);
    else entry[type] = data.base64EncodedStringWithOptions(0).js;
  }
  items.push(entry);
  unreadable.push(missing);
}
return JSON.stringify({ changeCount: board.changeCount, items, unreadable });`);

// An item can exceed the size limit of command arguments, so it is passed as a file.
const writeItems = jxa(`
const text = $.NSString.stringWithContentsOfFileEncodingError(input.file, $.NSUTF8StringEncoding, null).js;
input.items = JSON.parse(text);
${selectBoard}
board.clearContents;
const objects = $.NSMutableArray.array;
for (const entry of input.items) {
  const item = $.NSPasteboardItem.alloc.init;
  for (const [type, value] of Object.entries(entry)) {
    item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(value, 0), type);
  }
  objects.addObject(item);
}
if (input.items.length > 0 && !board.writeObjects(objects)) {
  throw new Error("pasteboard write failed for items with the types " + JSON.stringify(input.items.map((entry) => Object.keys(entry))));
}
return JSON.stringify(board.changeCount);`);

const releaseBoard = jxa(`
${selectBoard}
board.releaseGlobally;
return "null";`);

/**
 * The fault point of the pasteboard operations, null in production. `before(operation)` is called with `read` or `write` before
 * each operation runs on the real pasteboard, and an error that it throws is the failure of the operation. A test uses it for the
 * failures that the system pasteboard does not produce on demand, and to observe the order of the operations.
 */
export const pasteboardFault = { before: null };

/**
 * Reads every item of the pasteboard `name` (the general pasteboard when null) as base64 by format. unreadable lists, for each
 * item, the types whose data the pasteboard does not return, such as the type of a provider that has quit.
 */
export function readPasteboard(name = null) {
  pasteboardFault.before?.("read");
  return readItems({ name });
}

/** Replaces the pasteboard `name` (the general pasteboard when null) with items. items has the shape of readPasteboard().items. */
export function writePasteboard(items, name = null) {
  pasteboardFault.before?.("write");
  const directory = mkdtempSync(join(tmpdir(), "soksak-pasteboard-"));
  try {
    const file = join(directory, "items.json");
    writeFileSync(file, JSON.stringify(items));
    return writeItems({ file, name });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The items of a reading that a restore writes back, and a line for each item that loses types. An item whose types
 * return no data cannot be written, and an item without any type is refused by the pasteboard, so such an item is
 * left out and named.
 */
export function restorableItems({ items, unreadable }) {
  const restored = [];
  const skipped = [];
  for (const [index, item] of items.entries()) {
    const missing = unreadable[index];
    const empty = Object.keys(item).length === 0;
    if (missing.length > 0) {
      skipped.push(`item ${index + 1}: no readable data for ${missing.join(", ")}, so ${empty ? "it is not restored" : "only its other types are restored"}`);
    }
    if (!empty) restored.push(item);
  }
  return { items: restored, skipped };
}

/**
 * Releases a named pasteboard in the pasteboard server, so that its items do not outlive the test that created it. The general
 * pasteboard cannot be released.
 */
export function releasePasteboard(name) {
  if (typeof name !== "string" || name === "") throw new TypeError("a released pasteboard needs a name");
  releaseBoard({ name });
}

/** The text of the pasteboard `name` (the general pasteboard when null); null when there is no text. */
export function pasteboardText(name = null) {
  const { items } = readPasteboard(name);
  const text = items.find((item) => item["public.utf8-plain-text"] !== undefined)?.["public.utf8-plain-text"];
  return text === undefined ? null : Buffer.from(text, "base64").toString("utf8");
}

/**
 * The length of base64 data and the first 12 digits of its sha256. The content is data of the user, so it is not
 * disclosed.
 */
function digest(base64) {
  if (base64 === undefined) return "absent";
  const data = Buffer.from(base64, "base64");
  return `${data.length} bytes sha256 ${createHash("sha256").update(data).digest("hex").slice(0, 12)}`;
}

/**
 * Returns the first difference of the pasteboard items after a window check (after) from the items before (before) as
 * `<after> instead of <before>`. The order of the formats inside an item does not remain as written, so it is not
 * compared. It returns null when they are equal.
 */
export function pasteboardDifference(before, after) {
  if (before.length !== after.length) return `${after.length} items instead of ${before.length}`;
  for (const [index, item] of before.entries()) {
    const types = [...new Set([...Object.keys(item), ...Object.keys(after[index])])].sort();
    for (const type of types) {
      if (item[type] !== after[index][type]) return `item ${index + 1} ${type}: ${digest(after[index][type])} instead of ${digest(item[type])}`;
    }
  }
  return null;
}

/**
 * Returns why the restore of the pasteboard after a window check failed, or null. saved is the item list before the
 * check, written the change count that the restore returned, and after the reading of the comparison. A change count
 * other than written means that another process wrote the pasteboard between the restore and the comparison, so the
 * items do not show what the check left.
 */
export function restoreFailure(saved, written, after) {
  if (after.changeCount !== written) {
    return `another process wrote the pasteboard after the restore (change count ${written} after the restore, ${after.changeCount} at the comparison)`;
  }
  return pasteboardDifference(saved, after.items);
}
