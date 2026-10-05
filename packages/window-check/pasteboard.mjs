// 일반 페이스트보드의 모든 항목을 형식별로 읽고 쓴다. 하네스는 창 검사마다 사용자의 페이스트보드를 저장하고
// 검사가 끝나면 되돌린다(e2e/app.mjs 의 open).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// osascript 의 JavaScript 로 스크립트를 실행하고 JSON 결과를 돌려준다.
function jxa(body) {
  const script = `ObjC.import("AppKit");
function run(argv) { const input = JSON.parse(argv[0]); ${body} }`;
  return (input = {}) => {
    const output = execFileSync("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(input)],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return output.trim() === "" ? null : JSON.parse(output);
  };
}

const readItems = jxa(`
const board = $.NSPasteboard.generalPasteboard;
const items = [];
const list = board.pasteboardItems;
for (let i = 0; i < list.count; i++) {
  const item = list.objectAtIndex(i);
  const entry = {};
  const types = item.types;
  for (let k = 0; k < types.count; k++) {
    const type = types.objectAtIndex(k).js;
    const data = item.dataForType(type);
    if (!data.isNil()) entry[type] = data.base64EncodedStringWithOptions(0).js;
  }
  items.push(entry);
}
return JSON.stringify({ changeCount: board.changeCount, items });`);

// 항목은 명령 인자 크기 제한을 넘을 수 있으므로 파일로 넘긴다.
const writeItems = jxa(`
const text = $.NSString.stringWithContentsOfFileEncodingError(input.file, $.NSUTF8StringEncoding, null).js;
input.items = JSON.parse(text);
const board = $.NSPasteboard.generalPasteboard;
board.clearContents;
const objects = $.NSMutableArray.array;
for (const entry of input.items) {
  const item = $.NSPasteboardItem.alloc.init;
  for (const [type, value] of Object.entries(entry)) {
    item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(value, 0), type);
  }
  objects.addObject(item);
}
if (input.items.length > 0 && !board.writeObjects(objects)) throw new Error("pasteboard write failed");
return JSON.stringify(board.changeCount);`);

/** 일반 페이스트보드의 모든 항목을 형식별 base64 로 읽는다. */
export function readPasteboard() {
  return readItems();
}

/** 일반 페이스트보드를 items 로 바꾼다. items 는 readPasteboard().items 의 모양이다. */
export function writePasteboard(items) {
  const directory = mkdtempSync(join(tmpdir(), "soksak-pasteboard-"));
  try {
    const file = join(directory, "items.json");
    writeFileSync(file, JSON.stringify(items));
    return writeItems({ file });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 일반 페이스트보드의 텍스트. 텍스트가 없으면 null 이다. */
export function pasteboardText() {
  const { items } = readPasteboard();
  const text = items.find((item) => item["public.utf8-plain-text"] !== undefined)?.["public.utf8-plain-text"];
  return text === undefined ? null : Buffer.from(text, "base64").toString("utf8");
}

/** base64 자료의 길이와 sha256 앞 12자리. 내용은 사용자의 자료이므로 밝히지 않는다. */
function digest(base64) {
  if (base64 === undefined) return "absent";
  const data = Buffer.from(base64, "base64");
  return `${data.length} bytes sha256 ${createHash("sha256").update(data).digest("hex").slice(0, 12)}`;
}

/**
 * 창 검사 뒤의 페이스트보드 항목 after 가 앞의 before 와 다른 첫 차이를 `<after> instead of <before>` 로 돌려준다.
 * 항목 안 형식의 순서는 쓴 순서대로 남지 않으므로 비교하지 않는다. 같으면 null 이다.
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
