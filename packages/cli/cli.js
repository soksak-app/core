#!/usr/bin/env node
// soksak 명령: 로컬 엔드포인트의 exposure 메서드를 호출하고 결과를 JSON 으로 출력한다.
import { parseArgs } from "node:util";
import { connect } from "@soksak/client";

const usage = `usage: soksak <command> [options]

commands:
  windows
  list --window W
  status NAME --window W [--surface S] [--watch]
  run NAME --window W [--surface S] [--params JSON]
  dom rect|click|input NAME --window W [--surface S] [--index N] [--value V]
  input pointer --window W --x X --y Y --phase move|down|drag|up|scroll [--button left|right] [--delta-x N] [--delta-y N] [--activate]
  input key --window W --key K --phase down|up [--text T] [--modifiers shift,control,option,command]

common options:
  --config-dir DIR        configuration directory of the running application (required)`;

const options = {
  "config-dir": { type: "string" },
  window: { type: "string" },
  surface: { type: "string" },
  watch: { type: "boolean" },
  params: { type: "string" },
  index: { type: "string" },
  value: { type: "string" },
  x: { type: "string" },
  y: { type: "string" },
  phase: { type: "string" },
  button: { type: "string" },
  activate: { type: "boolean" },
  "delta-x": { type: "string" },
  "delta-y": { type: "string" },
  key: { type: "string" },
  text: { type: "string" },
  modifiers: { type: "string" },
  help: { type: "boolean" },
};

class UsageError extends Error {}

function number(values, name) {
  const text = values[name];
  if (text === undefined) return undefined;
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value)) throw new UsageError(`--${name} must be a number`);
  return value;
}

function required(values, name) {
  if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  return values[name];
}

function positional(positionals, index, what) {
  if (positionals[index] === undefined) throw new UsageError(`${what} is required`);
  return positionals[index];
}

// undefined 인 필드를 뺀 객체를 만든다.
function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

// 인자를 엔드포인트 요청 { method, params, watch } 로 바꾼다.
function plan(positionals, values) {
  const [command] = positionals;
  const window = () => required(values, "window");
  switch (command) {
    case "windows":
      return { method: "windows.list" };
    case "list":
      return { method: "exposure.list", params: { window: window() } };
    case "status": {
      const name = positional(positionals, 1, "NAME");
      return {
        method: values.watch ? "status.watch" : "status.get",
        params: compact({ window: window(), name, surface: values.surface }),
        watch: values.watch,
      };
    }
    case "run": {
      const name = positional(positionals, 1, "NAME");
      let params = {};
      if (values.params !== undefined) {
        try {
          params = JSON.parse(values.params);
        } catch (error) {
          throw new UsageError(`--params is not valid JSON: ${error.message}`);
        }
      }
      return { method: "command.run", params: compact({ window: window(), name, surface: values.surface, params }) };
    }
    case "dom": {
      const action = positional(positionals, 1, "dom action");
      const name = positional(positionals, 2, "NAME");
      const base = { window: window(), name, surface: values.surface, index: number(values, "index") };
      if (action === "rect") return { method: "dom.rect", params: compact(base) };
      if (action === "click") return { method: "dom.act", params: compact({ ...base, action: "click" }) };
      if (action === "input") return { method: "dom.act", params: compact({ ...base, action: "input", value: required(values, "value") }) };
      throw new UsageError(`unknown dom action: ${action}`);
    }
    case "input": {
      const kind = positional(positionals, 1, "input kind");
      if (kind === "pointer") {
        const phase = required(values, "phase");
        if (values.button !== undefined && !["left", "right"].includes(values.button)) {
          throw new UsageError("--button must be left or right");
        }
        if (values.activate && phase !== "move") throw new UsageError("--activate applies to --phase move");
        return {
          method: "input.pointer",
          params: compact({
            window: window(),
            x: number(values, "x") ?? required(values, "x"),
            y: number(values, "y") ?? required(values, "y"),
            phase,
            button: values.button,
            deltaX: number(values, "delta-x"),
            deltaY: number(values, "delta-y"),
            activate: values.activate,
          }),
        };
      }
      if (kind === "key") {
        return {
          method: "input.key",
          params: compact({
            window: window(),
            key: required(values, "key"),
            phase: required(values, "phase"),
            text: values.text,
            modifiers: values.modifiers?.split(",").filter(Boolean),
          }),
        };
      }
      throw new UsageError(`unknown input kind: ${kind}`);
    }
    case undefined:
      throw new UsageError("command is required");
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

// status --watch: 현재 값과 이후 변경마다 한 줄씩 출력한다. 연결이 끊기면 오류로 끝난다.
async function watch(client, { window, name, surface }, stdout) {
  let stopped = false;
  const stop = () => {
    stopped = true;
    client.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await client.watch(window, name, (value) => {
      stdout.write(`${JSON.stringify(value)}\n`);
      return false;
    }, { timeout: Infinity, surface });
  } catch (error) {
    if (!stopped) throw error;
  }
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const configDir = required(values, "config-dir");
  const request = plan(positionals, values);
  const client = await connect({ configDir });
  try {
    if (request.watch) {
      await watch(client, request.params, process.stdout);
      return;
    }
    const result = await client.request(request.method, request.params);
    process.stdout.write(`${JSON.stringify(result ?? null, null, 2)}\n`);
  } finally {
    client.close();
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (error) => {
    const code = error.code !== undefined ? ` (${error.code})` : "";
    process.stderr.write(`soksak: ${error.message}${code}\n`);
    if (error instanceof UsageError) process.stderr.write(`${usage}\n`);
    process.exit(error instanceof UsageError ? 2 : 1);
  },
);
