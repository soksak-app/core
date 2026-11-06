// Browser example check (docs/operations/examples.md#browser-example-check). Serves the staged browser example from a loopback
// server, opens a project through the library form in headless Chrome, and verifies that there are no console errors,
// unhandled exceptions, or error-level browser log entries.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import test from "node:test";

const BUILD = new URL("../build/", import.meta.url).pathname;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/* The longest time to wait for one step. A step that exceeds it fails as not finished. */
const STEP = 20000;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain" };

/** A loopback server that serves the build directory. replaced maps a path to JSON that is sent instead of the build file. */
function serve(replaced = {}) {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^\/+/, "");
    if (Object.hasOwn(replaced, path)) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(replaced[path]));
      return;
    }
    let file = join(BUILD, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(BUILD) || !existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Starts headless Chrome and returns the DevTools address. Chrome reports the port on standard error. */
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

/** The DevTools connection. send returns the result of a command, and on receives events. */
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

/**
 * Opens a project through the library form in the served browser example and waits for the sidebar section to mount. Returns
 * evaluate, which evaluates an expression in the page, and the collected errors.
 */
async function openProject(t, replaced, opened = `async () => {
    if (document.body.dataset.screen !== "workspace") return false;
    const { registry } = await import("/exposure.js");
    const reply = await registry.handle({ method: "status.get", params: { name: "core.sidebars" } });
    // 목록 배치는 모든 섹션을, 탭 배치는 고른 탭의 섹션만 그린다(docs/spec/plugins.md).
    const sections = reply.result.flatMap((sidebar) => sidebar.layout === "tabs"
      ? sidebar.sections.filter((section) => section.id === sidebar.tab) : sidebar.sections);
    return sections.length > 0 && sections.every((section) => section.mounted || section.error);
  }`) {
  assert.ok(existsSync(join(BUILD, "index.html")), `${BUILD} is not staged; run pnpm -F @soksak/browser frontend`);
  assert.ok(existsSync(CHROME), `Chrome is not installed at ${CHROME}; set CHROME`);
  const server = await serve(replaced);
  t.after(() => server.close());
  const profile = mkdtempSync(join(tmpdir(), "soksak-browser-example-"));
  const { chrome, address } = launch(profile);
  // Chrome writes to the profile folder until it exits, so the folder is removed after the exit event arrives.
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

  /** Evaluates an expression in the page and returns the value. An exception in the page is a failure. */
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  };
  /**
   * Waits until a condition expression is true in the page. It evaluates the expression again whenever the document changes, and if it is not true within STEP,
   * it fails and reports the last value.
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
  // Opens the form, enters the path, and opens it as a person does. The controls are bound to declared commands.
  await evaluate(`document.querySelector('[data-expose="core.library.add"]').click()`);
  await until(`() => document.querySelector('[data-expose="core.library.form.parent"]')`, "the folder form did not open");
  await evaluate(`(() => { const input = document.querySelector('[data-expose="core.library.form.parent"]');
    input.value = "/work/browser-example"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await evaluate(`document.querySelector('[data-expose="core.library.form.submit"]').click()`);
  await until(opened, "the project did not open with its sidebar sections").catch(async (error) => {
    const state = await evaluate(`(async () => { const { registry } = await import("/exposure.js");
      return { screen: document.body.dataset.screen,
        sidebars: (await registry.handle({ method: "status.get", params: { name: "core.sidebars" } })),
        slots: [...document.querySelectorAll(".slot")].map((el) => ({ ...el.dataset, children: [...el.children].map((child) => child.className) })) }; })()`);
    throw new Error(`${error.message}; page state ${JSON.stringify(state)}; errors ${JSON.stringify(errors)}`);
  });
  const sections = await evaluate(`(async () => { const { registry } = await import("/exposure.js");
    return (await registry.handle({ method: "status.get", params: { name: "core.sidebars" } })).result
      .flatMap((sidebar) => sidebar.sections.map((section) => [section.id, section.error])); })()`);
  assert.deepEqual(sections.filter(([, error]) => error), [], "a section failed to mount");
  return { evaluate, errors };
}

test("a project opens in the served browser example without a console error", async (t) => {
  const { errors } = await openProject(t);
  assert.deepEqual(errors, [], `the page reported errors: ${errors.join("; ")}`);
});

test("a tab of a plugin that is not loaded opens as a placeholder card without an error", async (t) => {
  // The workspace of the environment holds a terminal tab, so in a plugin list without terminal that tab is a placeholder (docs/spec/plugins.md).
  const installed = JSON.parse(readFileSync(join(BUILD, "installed-plugins.json"), "utf8"));
  assert.ok(installed.plugins.some((plugin) => plugin.id === "terminal"), "the staged plugin list has no terminal plugin");
  // The open is judged by the placeholder being visible.
  const { evaluate, errors } = await openProject(t, {
    "installed-plugins.json": { plugins: installed.plugins.filter((plugin) => plugin.id !== "terminal") },
  }, `() => document.body.dataset.screen === "workspace" && document.querySelector("[data-plugin-placeholder]")`);
  const surfaces = await evaluate(`(async () => { const { registry } = await import("/exposure.js");
    return (await registry.handle({ method: "status.get", params: { name: "core.surfaces" } })).result
      .filter((surface) => surface.placeholder !== null).map((surface) => [surface.plugin, surface.placeholder]); })()`);
  assert.ok(surfaces.length > 0 && surfaces.every(([plugin, reason]) => plugin === "terminal" && reason === "host"), JSON.stringify(surfaces));
  const lines = await evaluate(`[...document.querySelectorAll('[data-plugin-placeholder]')].map((el) => el.textContent)`);
  assert.ok(lines.length > 0 && lines.every((line) => line === "terminal 플러그인은 네이티브 호스트가 있어야 설치됩니다."), JSON.stringify(lines));
  assert.deepEqual(errors, [], `the page reported errors: ${errors.join("; ")}`);
});
