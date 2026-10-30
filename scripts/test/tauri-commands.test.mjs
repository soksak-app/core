import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findWorkerBodies } from "../check-tauri-commands.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scan = (source) => findWorkerBodies(source).map((item) => `${item.line} ${item.name}: ${item.reason}`);

test("an async command whose body runs on a worker of the async runtime is found", () => {
  assert.deepEqual(scan([
    "#[tauri::command(async)]",
    "fn forward(webview: Webview) -> Result<(), String> {",
    "    exposure::forward(&webview)",
    "}",
    "#[tauri::command]",
    "async fn wait(webview: Webview) -> Result<(), String> {",
    "    exposure::wait(&webview)",
    "}",
    "#[tauri::command]",
    "async fn run<R: tauri::Runtime>(app: AppHandle<R>) -> Result<(), String> {",
    "    plugins::run(&app)",
    "}",
    "",
  ].join("\n")), [
    "1 forward: a synchronous body runs on a worker of the async runtime",
    "5 wait: the body of an async command does not run through blocking(move || ...)",
    "9 run: the body of an async command does not run through blocking(move || ...)",
  ]);
});

test("an async command whose body runs on the blocking threads and a synchronous command are accepted", () => {
  assert.deepEqual(scan([
    "#[tauri::command]",
    "async fn forward(webview: Webview, request: Argument<Forward>) -> Result<(), String> {",
    "    let Argument(request) = request;",
    "    blocking(move || exposure::forward(&webview, request)).await",
    "}",
    "#[tauri::command]",
    "async fn present(window: Window) -> Result<(), String> {",
    "    surfaces::present(window).await",
    "}",
    "#[tauri::command]",
    "fn release(window: Window) -> Result<(), String> {",
    "    windows::release(&window)",
    "}",
    "",
  ].join("\n")), []);
});

test("every async command of the Tauri host runs its body on the blocking threads of the async runtime", () => {
  const output = spawnSync(process.execPath, [join(ROOT, "scripts/check-tauri-commands.mjs")], { encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
});
