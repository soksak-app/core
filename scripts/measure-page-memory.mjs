// 실행 중인 애플리케이션의 main page process 메모리를 시작 시점, 유휴 뒤, 다시 읽기 뒤에 잰다.
//
// 애플리케이션 번들의 sok 으로 창의 host.window 상태(pageProcess)를 읽고 host.window.reload 를 실행하므로 release 빌드도
// 잰다. 메모리는 운영체제의 footprint 가 보고하는 physical footprint 다. 유휴 구간은 아무 사건도 기다리지 않는 시간이므로
// 시간으로 정한다. 단계마다 {phase, elapsedMs, pageProcess, footprint} 를 JSON 한 줄로 출력하고, 판정하지 않는다.
// `make page-memory` 가 실행한다.
//
//   node scripts/measure-page-memory.mjs --sok PATH --config-dir DIR [--idle-minutes N] [--reloads N]
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * 단계를 차례로 잰다. status() 는 host.window 상태, reload() 는 다시 읽기 한 번, footprint(pid) 는 바이트 수, wait(ms) 는
 * 유휴 구간이다. 다시 읽기가 page process 를 바꾸면 오류를 낸다.
 */
export async function measure({ status, reload, footprint, wait, idleMs, reloads, log, now = Date.now }) {
  const started = now();
  const record = async (phase) => {
    const { pageProcess } = await status();
    if (!Number.isInteger(pageProcess) || pageProcess <= 0) throw new Error(`${phase}: the window has no page process (${pageProcess})`);
    const entry = { phase, elapsedMs: now() - started, pageProcess, footprint: footprint(pageProcess) };
    log(entry);
    return entry;
  };
  const start = await record("start");
  await wait(idleMs);
  await record("idle");
  for (let i = 0; i < reloads; i++) await reload();
  const after = await record("reloads");
  if (after.pageProcess !== start.pageProcess) {
    throw new Error(`the reloads changed the page process from ${start.pageProcess} to ${after.pageProcess}`);
  }
}

/** footprint 출력의 바이트 수. */
export function parseFootprint(text) {
  const match = text.match(/Footprint: (\d+) B/);
  if (!match) throw new Error(`footprint reported no byte count: ${text.slice(0, 200)}`);
  return Number(match[1]);
}

/** 명령줄 옵션. */
export function parseOptions(args) {
  const options = { idleMinutes: 60, reloads: 20 };
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [args[index], args[index + 1]];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (name === "--sok") options.sok = value;
    else if (name === "--config-dir") options.configDir = value;
    else if (name === "--idle-minutes" || name === "--reloads") {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
      options[name === "--reloads" ? "reloads" : "idleMinutes"] = number;
    } else throw new Error(`unknown option: ${name}`);
  }
  if (!options.sok || !options.configDir) throw new Error("required options: --sok PATH --config-dir DIR");
  return options;
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const sok = (...args) => execFileSync(options.sok, [...args, "--config-dir", options.configDir], { encoding: "utf8" });
  await measure({
    status: async () => JSON.parse(sok("status", "host.window")),
    reload: async () => { sok("host.window.reload"); },
    footprint: (pid) => parseFootprint(execFileSync("footprint", ["-p", String(pid), "-f", "bytes"], { encoding: "utf8" })),
    wait: (ms) => sleep(ms),
    idleMs: options.idleMinutes * 60_000,
    reloads: options.reloads,
    log: (entry) => console.log(JSON.stringify(entry)),
  });
}
