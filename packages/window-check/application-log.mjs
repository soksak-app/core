// 검사하는 애플리케이션의 로그에서 오류 기록을 읽는다. 로그의 줄은 `<time> <level> <layer> <where>: <text>` 형식의 글 기록이고
// level 이 error 인 기록이 오류다(docs/spec/diagnostics.md#forms). 문서의 오류 표시는 다음 reload 가 지우지만 로그의 기록은
// 남으므로, 검사는 로그로 검사 동안의 모든 오류 발생을 판정한다.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RECORD = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (error|info) (page|host|native|sidecar) (.+)$/;

/**
 * 줄을 글 기록 {time, level, layer, where, text} 로 읽는다. 형식이 없는 줄(운영체제와 런타임의 출력)은 null 이다. where 는
 * 처음 나오는 `: ` 에서 끝나며, `: ` 가 없는 줄도 기록이 아니다.
 */
export function parseRecord(line) {
  const match = RECORD.exec(line);
  if (!match) return null;
  const rest = match[4];
  const at = rest.indexOf(": ");
  if (at <= 0) return null;
  return { time: match[1], level: match[2], layer: match[3], where: rest.slice(0, at), text: rest.slice(at + 2) };
}

/** 설정 폴더의 애플리케이션 로그와 그 이전 세대(크기 제한으로 이름을 바꾼 파일). */
export const applicationLog = (configDir) => join(configDir, "logs", "application.log");

/**
 * 검사가 로그를 마지막으로 읽은 위치를 기록하는 파일. 설정 폴더 옆에 두어 설정 폴더마다 하나다. 검사 사이에 쓰인
 * 줄도 다음 검사가 읽도록 위치를 검사 파일과 실행을 넘어 잇는다.
 */
export const offsetFile = (configDir) => `${configDir}.log-offset`;

/** 마지막으로 읽은 위치. 기록이 없으면 로그의 처음부터 읽으므로 시작 중의 오류도 첫 검사가 판정한다. */
export function readOffset(configDir) {
  const file = offsetFile(configDir);
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, "utf8").trim();
  if (!/^\d+$/.test(text)) throw new Error(`${file}: expected a byte offset, found ${JSON.stringify(text)}`);
  return Number(text);
}

export function writeOffset(configDir, offset) {
  writeFileSync(offsetFile(configDir), `${offset}\n`);
}

function readFrom(path, offset) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.max(0, size - offset);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, offset + read);
      if (n === 0) throw new Error(`${path}: the file ended at ${offset + read} bytes while ${size} were expected`);
      read += n;
    }
    return { text: buffer.toString("utf8"), size };
  } finally {
    closeSync(fd);
  }
}

/** 줄에서 시각을 뺀 기록 `<level> <layer> <where>: <text>`. 기록이 아닌 줄은 줄 그대로다. */
export function withoutTime(line) {
  const record = parseRecord(line);
  return record === null ? line : `${record.level} ${record.layer} ${record.where}: ${record.text}`;
}

/**
 * offset 뒤에 쓰인 오류 기록(시각을 뺀 `error <layer> <where>: <text>`), 형식이 없는 줄, 새 끝 위치. 읽는 범위는 readLines 와
 * 같다. 형식이 없는 줄은 운영체제와 런타임의 출력이며 오류로 판정하지 않고 검사가 보고하도록 돌려준다.
 */
export function readErrors(configDir, offset) {
  const { lines, end } = readLines(configDir, offset);
  const errors = [];
  const unformatted = [];
  for (const line of lines) {
    const record = parseRecord(line);
    if (record === null) unformatted.push(line);
    else if (record.level === "error") errors.push(`error ${record.layer} ${record.where}: ${record.text}`);
  }
  return { errors, unformatted, end };
}

/**
 * offset 뒤에 쓰인 줄과 새 끝 위치. 줄이 끝나지 않은 마지막 조각은 읽지 않고 다음에 읽는다. 로그가 offset 보다
 * 작으면 호스트가 다시 시작하며 이전 세대로 옮긴 것이므로, 이전 세대의 나머지와 새 로그를 처음부터 읽는다.
 */
export function readLines(configDir, offset) {
  const path = applicationLog(configDir);
  if (!existsSync(path)) throw new Error(`${path} does not exist; the application writes its log there (docs/spec/hosts.md#application-log)`);
  let text = "";
  let start = offset;
  let current = readFrom(path, 0).size;
  if (current < offset) {
    const previous = `${path}.1`;
    if (!existsSync(previous)) throw new Error(`${path} is shorter than the ${offset} bytes already read and ${previous} does not exist`);
    text += readFrom(previous, offset).text;
    start = 0;
  }
  const latest = readFrom(path, start);
  current = latest.size;
  text += latest.text;
  const complete = text.lastIndexOf("\n") + 1;
  const unread = Buffer.byteLength(text.slice(complete));
  const lines = complete === 0 ? [] : text.slice(0, complete - 1).split("\n");
  return { lines, end: Math.max(0, current - unread) };
}
