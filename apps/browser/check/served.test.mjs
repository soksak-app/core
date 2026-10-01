// 브라우저 예제 검사(docs/operations/examples.md#browser-example-check). 스테이징된 브라우저 예제를 루프백
// 서버로 제공하고 headless Chrome 에서 라이브러리 폼으로 프로젝트를 연 뒤, 콘솔 오류, 처리되지 않은 예외,
// 오류 수준의 브라우저 로그가 없는지 확인한다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import test from "node:test";

const BUILD = new URL("../build/", import.meta.url).pathname;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/* 한 단계를 기다리는 가장 긴 시간. 넘으면 그 단계가 끝나지 않은 것으로 실패한다. */
const STEP = 20000;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain" };

/** build 디렉터리를 제공하는 루프백 서버. */
function serve() {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^\/+/, "");
    let file = join(BUILD, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(BUILD) || !existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** headless Chrome 을 띄우고 DevTools 주소를 반환한다. 포트는 Chrome 이 표준 오류에 알린다. */
function launch(profile) {
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const address = new Promise((resolve, reject) => {
    let text = "";
    chrome.stderr.on("data", (chunk) => {
      text += chunk;
      const found = text.match(/DevTools listening on (ws:\/\/\S+)/);
      if (found) resolve(found[1]);
    });
    chrome.on("exit", (code) => reject(new Error(`Chrome exited with ${code} before listening: ${text}`)));
  });
  return { chrome, address };
}

/** DevTools 연결. send 는 명령의 결과를, on 은 이벤트를 받는다. */
async function devtools(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error(`cannot connect ${url}`)); });
  let next = 0;
  const waiting = new Map();
  const listeners = new Set();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id !== undefined) {
      const entry = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    for (const fn of listeners) fn(message);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, on: (fn) => listeners.add(fn), close: () => socket.close() };
}

test("a project opens in the served browser example without a console error", async (t) => {
  assert.ok(existsSync(join(BUILD, "index.html")), `${BUILD} is not staged; run pnpm -F @soksak/browser frontend`);
  assert.ok(existsSync(CHROME), `Chrome is not installed at ${CHROME}; set CHROME`);
  const server = await serve();
  t.after(() => server.close());
  const profile = mkdtempSync(join(tmpdir(), "soksak-browser-example-"));
  const { chrome, address } = launch(profile);
  // Chrome 이 끝나야 profile 폴더에 더 쓰지 않으므로, 종료 사건을 받은 뒤 지운다.
  t.after(async () => {
    const exited = chrome.exitCode === null ? new Promise((resolve) => chrome.once("exit", resolve)) : null;
    chrome.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true });
  });
  const cdp = await devtools(await address);
  t.after(() => cdp.close());

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => cdp.send(method, params, sessionId);
  const errors = [];
  cdp.on((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") errors.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      errors.push(`console.error: ${message.params.args.map((arg) => arg.value ?? arg.description).join(" ")}`);
    }
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") errors.push(`log: ${message.params.entry.text} ${message.params.entry.url ?? ""}`);
  });
  await page("Runtime.enable");
  await page("Log.enable");
  await page("Page.enable");

  /** 페이지에서 식을 계산하고 값을 반환한다. 페이지의 예외는 실패다. */
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  };
  /**
   * 페이지에서 조건 식이 참이 될 때까지 기다린다. 문서가 바뀔 때마다 다시 계산하고, STEP 안에 참이 되지 않으면
   * 마지막 값을 적어 실패한다.
   */
  const until = (condition, what) => evaluate(`new Promise((resolve, reject) => {
    const check = async () => { try { return await (${condition})(); } catch (error) { return false; } };
    const observer = new MutationObserver(async () => { if (await check()) { observer.disconnect(); resolve(true); } });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    check().then((done) => { if (done) { observer.disconnect(); resolve(true); } });
    setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`${what} within ${STEP} ms`)})); }, ${STEP});
  })`);

  const origin = `http://127.0.0.1:${server.address().port}`;
  await page("Page.navigate", { url: `${origin}/` });
  await until(`() => document.body?.dataset.screen === "library" && document.querySelector('[data-expose="core.library.add"]')`,
    "the library did not show");
  // 사람이 하듯 폼을 열고 경로를 입력하고 연다. 조작 요소는 선언된 명령에 연결되어 있다.
  await evaluate(`document.querySelector('[data-expose="core.library.add"]').click()`);
  await until(`() => document.querySelector('[data-expose="core.library.form.parent"]')`, "the folder form did not open");
  await evaluate(`(() => { const input = document.querySelector('[data-expose="core.library.form.parent"]');
    input.value = "/work/browser-example"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await evaluate(`document.querySelector('[data-expose="core.library.form.submit"]').click()`);
  await until(`async () => {
    if (document.body.dataset.screen !== "workspace") return false;
    const { registry } = await import("/exposure.js");
    const reply = await registry.handle({ method: "status.get", params: { name: "core.sidebars" } });
    const sections = reply.result.flatMap((sidebar) => sidebar.sections);
    return sections.length > 0 && sections.every((section) => section.mounted || section.error);
  }`, "the project did not open with its sidebar sections").catch(async (error) => {
    const state = await evaluate(`(async () => { const { registry } = await import("/exposure.js");
      return { screen: document.body.dataset.screen,
        sidebars: (await registry.handle({ method: "status.get", params: { name: "core.sidebars" } })) }; })()`);
    throw new Error(`${error.message}; page state ${JSON.stringify(state)}; errors ${JSON.stringify(errors)}`);
  });
  const sections = await evaluate(`(async () => { const { registry } = await import("/exposure.js");
    return (await registry.handle({ method: "status.get", params: { name: "core.sidebars" } })).result
      .flatMap((sidebar) => sidebar.sections.map((section) => [section.id, section.error])); })()`);
  assert.deepEqual(sections.filter(([, error]) => error), [], "a section failed to mount");
  assert.deepEqual(errors, [], `the page reported errors: ${errors.join("; ")}`);
});
