// 검사하는 애플리케이션의 event log에서 오류 event를 읽는다. 호스트 프로세스는 실행마다 `logs/host-<boot>.jsonl`에
// 줄마다 event 하나를 쓰고, level 이 error 인 event 가 오류다(docs/spec/logging.md#files).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOST_LOG = /^host-.+\.jsonl$/;

/** 파일마다 마지막으로 읽은 위치를 기록하는 파일. 설정 폴더 옆에 두어 설정 폴더마다 하나다. */
export const eventOffsetFile = (configDir) => `${configDir}.event-offsets`;

/** 파일 이름 → 마지막으로 읽은 위치. 기록이 없으면 비어 있어 모든 파일을 처음부터 읽는다. */
export function readEventOffsets(configDir) {
  const file = eventOffsetFile(configDir);
  if (!existsSync(file)) return {};
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !Object.values(value).every((offset) => Number.isInteger(offset) && offset >= 0)) {
    throw new Error(`${file}: expected an object of byte offsets, found ${JSON.stringify(value)}`);
  }
  return value;
}

export function writeEventOffsets(configDir, offsets) {
  writeFileSync(eventOffsetFile(configDir), `${JSON.stringify(offsets)}\n`);
}

/**
 * 모든 호스트 event log 에서 offsets 뒤에 쓰인 오류 event(`error <layer> <event>: <fields>`)와 새 위치. 줄이 끝나지 않은
 * 마지막 조각은 읽지 않고 다음에 읽는다. 줄이 event 가 아니거나, 파일이 읽은 위치보다 짧거나, event log 가 하나도 없으면
 * 파일 이름을 담은 오류다.
 */
export function readEventErrors(configDir, offsets) {
  const logs = join(configDir, "logs");
  const names = readdirSync(logs).filter((name) => HOST_LOG.test(name)).sort();
  if (names.length === 0) throw new Error(`${logs} holds no host event log; the application writes it there (docs/spec/logging.md#files)`);
  const errors = [];
  const next = {};
  for (const name of names) {
    const path = join(logs, name);
    const offset = offsets[name] ?? 0;
    const size = statSync(path).size;
    if (size < offset) throw new Error(`${path} is shorter than the ${offset} bytes already read`);
    const data = readFileSync(path);
    const text = data.subarray(offset).toString("utf8");
    const complete = text.lastIndexOf("\n") + 1;
    const lines = complete === 0 ? [] : text.slice(0, complete - 1).split("\n");
    // The line number counts from the start of the file, so the error names the line a person opens.
    let lineNumber = data.subarray(0, offset).filter((byte) => byte === 0x0a).length;
    for (const line of lines) {
      lineNumber += 1;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${lineNumber}: the line is not valid JSON: ${error.message}`);
      }
      if (typeof event?.level !== "string") throw new Error(`${path}:${lineNumber}: the event has no level`);
      if (event.level === "error") errors.push(`error ${event.layer} ${event.event}: ${JSON.stringify(event.fields ?? {})}`);
    }
    next[name] = offset + Buffer.byteLength(text.slice(0, complete));
  }
  return { errors, offsets: next };
}
