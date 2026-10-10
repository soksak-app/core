// 검사하는 애플리케이션의 event log에서 오류 event를 읽는다. 호스트 프로세스는 실행마다 `logs/host-<boot>.jsonl`에
// 줄마다 event 하나를 쓰고, level 이 error 인 event 가 오류다(docs/spec/logging.md#files).
import { existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
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

const RECORD_EVENT = /^(host|page|native|sidecar|plugin)\.record\.(error|warn|info|debug|trace)$/;

/**
 * event 하나의 줄. 기록 event(`<layer>.record.<level>` `{where, text}`)는 글 형식의 줄 `<level> <layer> <where>: <text>` 이고
 * 다른 event 는 `<level> <layer> <event>: <fields>` 다.
 */
export function eventLine(event) {
  if (RECORD_EVENT.test(event.event)) {
    const { where, text } = event.fields ?? {};
    if (typeof where !== "string" || typeof text !== "string") {
      throw new Error(`the record event ${event.event} needs where and text as strings, found ${JSON.stringify(event.fields)}`);
    }
    return `${event.level} ${event.layer} ${where}: ${text}`;
  }
  return `${event.level} ${event.layer} ${event.event}: ${JSON.stringify(event.fields ?? {})}`;
}

/**
 * 모든 호스트 event log 에서 offsets 뒤에 쓰인 event 와 새 위치. 줄이 끝나지 않은 마지막 조각은 읽지 않고 다음에 읽는다.
 * 줄이 event 가 아니거나, 파일이 읽은 위치보다 짧거나, event log 가 하나도 없으면 파일 이름을 담은 오류다.
 */
export function readEvents(configDir, offsets) {
  const logs = join(configDir, "logs");
  const names = readdirSync(logs).filter((name) => HOST_LOG.test(name)).sort();
  if (names.length === 0) throw new Error(`${logs} holds no host event log; the application writes it there (docs/spec/logging.md#files)`);
  const events = [];
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
      events.push(event);
    }
    next[name] = offset + Buffer.byteLength(text.slice(0, complete));
  }
  return { events, offsets: next };
}

/** offsets 뒤에 쓰인 오류 event 의 줄(`error <layer> <where 또는 event>: <text 또는 fields>`)과 새 위치. */
export function readEventErrors(configDir, offsets) {
  const { events, offsets: next } = readEvents(configDir, offsets);
  return { errors: events.filter((event) => event.level === "error").map(eventLine), offsets: next };
}

/** offsets 뒤에 쓰인 모든 event 의 줄과 새 위치. */
export function readEventLines(configDir, offsets) {
  const { events, offsets: next } = readEvents(configDir, offsets);
  return { lines: events.map(eventLine), offsets: next };
}

/**
 * offsets 뒤에 쓰인 event 의 줄 전체가 predicate 를 만족할 때까지 기다리고 그 줄을 돌려준다. 기록은 비동기 writer 가 배치 간격마다
 * 파일에 쓰므로, 호스트 event log 파일마다 변경 알림(fs.watch)을 걸어 알림이 올 때마다 다시 읽는다. 폴더의 알림은 다른 프로세스가
 * 파일에 덧붙이는 내용을 알리지 못하므로 새 파일을 알아채는 데만 쓴다. 기한이 지나면 읽은 줄을 담은 오류로 거부한다.
 */
export function untilEventLines(configDir, offsets, predicate, timeout) {
  return new Promise((resolve, reject) => {
    const logs = join(configDir, "logs");
    const watchers = new Map();
    let finished = false;
    let timer;
    const stop = () => {
      finished = true;
      clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
    };
    const fail = (error) => {
      if (finished) return;
      stop();
      reject(error);
    };
    // Every host event log has a watcher, including a file that a later run created.
    const watchFiles = () => {
      for (const name of readdirSync(logs).filter((entry) => HOST_LOG.test(entry))) {
        if (!watchers.has(name)) watchers.set(name, watch(join(logs, name), check));
      }
    };
    function check() {
      if (finished) return;
      try {
        watchFiles();
        const { lines } = readEventLines(configDir, offsets);
        if (predicate(lines)) {
          stop();
          resolve(lines);
        }
      } catch (error) {
        fail(error);
      }
    }
    const folder = watch(logs, check);
    watchers.set("", folder);
    const seen = () => {
      try {
        return JSON.stringify(readEventLines(configDir, offsets).lines.slice(-8));
      } catch (error) {
        return `unreadable: ${error.message}`;
      }
    };
    timer = setTimeout(() => {
      if (finished) return;
      const lines = seen();
      stop();
      reject(new Error(`no event line matched within ${timeout} ms; the lines after the offsets: ${lines}`));
    }, timeout);
    check();
  });
}

/** offsets 뒤에 쓰인 event 의 줄 중 predicate 가 받아들이는 첫 줄을 timeout 안에 돌려준다. */
export async function untilEventLine(configDir, offsets, predicate, timeout) {
  const lines = await untilEventLines(configDir, offsets, (all) => all.some(predicate), timeout);
  return lines.find(predicate);
}

// The prefixes of the events of the trace and the layer of the row that each one makes.
const TRACE_PREFIXES = [["page.trace.", "page"], ["host.trace.", "host"], ["host.sampler.", "sampler"]];

/**
 * The events of the trace of the page, the host and the sampler as rows in the shape of the trace file of earlier runs: the
 * layer, the event name without the prefix, the time as an ISO-8601 text with milliseconds, and the fields of the event.
 */
export function traceRows(events) {
  const rows = [];
  for (const event of events) {
    const match = TRACE_PREFIXES.find(([prefix]) => event.event.startsWith(prefix));
    if (!match) continue;
    rows.push({ layer: match[1], event: event.event.slice(match[0].length), ts: new Date(event.ts_us / 1000).toISOString(), ...event.fields });
  }
  return rows;
}

/**
 * The end of the complete lines of every host event log now. A check that reads what the application wrote after a moment
 * takes this position first; `readEventOffsets` is the position at which the earlier session ended, which the harness uses
 * to judge the errors between two checks.
 */
export function currentEventOffsets(configDir) {
  const logs = join(configDir, "logs");
  const offsets = {};
  for (const name of readdirSync(logs).filter((entry) => HOST_LOG.test(entry)).sort()) {
    const data = readFileSync(join(logs, name));
    offsets[name] = data.lastIndexOf(0x0a) + 1;
  }
  return offsets;
}
