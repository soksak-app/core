// Reads the declared content of a plugin view through the public value of the plugin that holds it, and checks that the host
// presents the region that shows it (docs/features.md F696-4).
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeViewText } from "@soksak/window-check/view-metrics.mjs";
import { FIXTURE, lines } from "./hwp-support.mjs";
import { presentedScreen, textLines } from "./terminal-screen.mjs";

/** Copies one applied view's exact opaque BGRA crop without resizing or changing channels. */
export function cropViewPixels(frame, rect) {
  assert.ok(frame.data instanceof Uint8Array && frame.data.length === frame.stride * frame.height,
    "capture pixel storage does not match its declared stride and height");
  const ratio = frame.scale * frame.contentScale;
  assert.ok([ratio, rect.x, rect.y, rect.w, rect.h, frame.content.x, frame.content.y].every(Number.isFinite)
    && ratio > 0 && rect.w > 0 && rect.h > 0, "invalid captured view geometry");
  const x = Math.floor(frame.content.x * frame.scale + rect.x * ratio);
  const y = Math.floor(frame.content.y * frame.scale + rect.y * ratio);
  const width = Math.ceil(frame.content.x * frame.scale + (rect.x + rect.w) * ratio) - x;
  const height = Math.ceil(frame.content.y * frame.scale + (rect.y + rect.h) * ratio) - y;
  assert.ok(x >= 0 && y >= 0 && x + width <= frame.width && y + height <= frame.height,
    "the applied view crop lies outside its recorded frame");
  assert.ok(width * height * 4 <= 64 * 1024 * 1024, "the view crop exceeds 64 MiB");
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    data.set(frame.data.subarray((y + row) * frame.stride + x * 4,
      (y + row) * frame.stride + (x + width) * 4), row * width * 4);
  }
  return { width, height, data };
}

/** The visible document region `document` of surface in host.window, or a failure that names what it holds. */
async function visibleDocument(s, surface, document) {
  const host = await s.get("host.window");
  const row = host.documents.find((item) => item.surface === surface && item.document === document);
  assert.ok(row?.visible && row.frame.width > 0 && row.frame.height > 0,
    `${surface} shows no document region ${JSON.stringify(document)}: ${JSON.stringify(row)}`);
  return row;
}

/**
 * The text that the plugin of surface holds as its shown content: the empty instruction of the browser (browser.content.read),
 * the document text of the editor (editor.read), the glyphs of the first page of hwp (getPageSvg) and the cell rows of a terminal
 * whose frame its image region presented (term.screen.read and terminal.screen.read). A page plugin shows it in its visible
 * document region; the caller waits for the presentation of the window (host.window.presented) after this read.
 */
export async function readViewContent(s, plugin, surface) {
  if (plugin === "term" || plugin === "terminal") {
    const screen = await presentedScreen(s, surface, plugin);
    return textLines({ lines: screen.rows }).join("\n");
  }
  await visibleDocument(s, surface, "");
  if (plugin === "browser") {
    const value = await s.run("browser.content.read", {}, surface);
    assert.equal(value?.kind, "empty", `browser ${surface} does not show its empty instruction: ${JSON.stringify(value)}`);
    return value.instruction;
  }
  if (plugin === "editor") return s.run("editor.read", {}, surface);
  if (plugin === "hwp") {
    await visibleDocument(s, surface, "studio");
    return (await lines(s, surface)).join("\n");
  }
  throw new Error(`plugin ${plugin} has no content value`);
}

/**
 * The proof of a content check of a measurement, {method: "value", expected, actual}, after checking that the content text
 * actual that a check read holds expected. owner names the view in a failure.
 */
export function valueProof(expected, actual, owner = "the view") {
  assert.ok(typeof expected === "string" && normalizeViewText(expected).length > 0, "view content requires nonempty expected text");
  assert.equal(typeof actual, "string", `${owner} content is not text: ${JSON.stringify(actual)}`);
  assert.ok(normalizeViewText(actual).includes(normalizeViewText(expected)),
    `${owner} does not show ${JSON.stringify(expected)}: ${JSON.stringify(actual)}`);
  return { method: "value", expected, actual };
}

/** Reads the content of surface (readViewContent) and returns the proof that it holds expected (valueProof). */
export async function viewContentProof(s, plugin, surface, expected) {
  return valueProof(expected, await readViewContent(s, plugin, surface), `${plugin} ${surface}`);
}

/** The content check of a view: it reads the content of surface after the display and checks that it holds expected. */
function shows(s, plugin, surface, expected, diagnostic) {
  return async () => {
    await viewContentProof(s, plugin, surface, expected);
    diagnostic(`${plugin} ${surface} shows ${JSON.stringify(expected)}`);
  };
}

/** Declared per-plugin readiness and fixed content expectations for the installed fixture. */
export async function viewContentCases(s, diagnostic) {
  const { root } = await s.get("core.project");
  const folder = `view-content-${process.pid}`;
  mkdirSync(join(root, folder));
  s.cleanup(() => rmSync(join(root, folder), { recursive: true, force: true }));
  const editorPath = `${folder}/content.txt`;
  const hwpPath = `${folder}/content.hwp`;
  const editorText = "SOKSAK EDITOR CONTENT";
  const terminalText = "SOKSAK TERMINAL CONTENT";
  const termText = "SOKSAK TERM CONTENT";
  writeFileSync(join(root, editorPath), editorText + "\n");
  copyFileSync(FIXTURE, join(root, hwpPath));
  const status = async (tab, name, predicate) => {
    await s.until("core.surfaces", all => all.some(item => item.surface === tab
      && item.exposes.includes(`status ${name}`)), `${tab} did not register ${name}`);
    return s.until(name, predicate, `${tab} did not reach ${name} readiness`, { surface: tab });
  };
  const area = async (tab, name) => {
    const rect = await s.rect(name, undefined, tab);
    assert.ok(rect.width > 0 && rect.height > 0, `${tab}: ${name} has no visible area`);
  };
  return new Map([
    ["browser", { ready: async (_, { tab }) => {
      const location = await status(tab, "browser.location", value => !value.loading && value.error === null);
      assert.equal(location.url, "", "the initial browser must show its empty state");
      await area(tab, "browser.empty");
      return shows(s, "browser", tab, "주소를 입력하세요", diagnostic);
    } }],
    ["editor", { params: { path: editorPath }, ready: async (_, { tab }) => {
      await status(tab, "editor.document", value => value.path === editorPath && value.length === editorText.length + 1);
      await area(tab, "editor.content");
      return shows(s, "editor", tab, editorText, diagnostic);
    } }],
    ["hwp", { params: { path: hwpPath }, ready: async (_, { tab }) => {
      await status(tab, "hwp.document", value => value.path === hwpPath && value.phase === "ready" && value.pages === 1);
      await area(tab, "hwp.studio");
      return shows(s, "hwp", tab, "속삭한글문서확인", diagnostic);
    } }],
    ["term", { ready: async (_, { tab }) => {
      await status(tab, "term.session", value => value.sessionId && value.cols > 0 && value.rows > 0);
      await s.run("term.input", { bytes: `printf '${termText}\\n'\r` }, tab);
      await status(tab, "term.screen", rows => rows.map(row => row.map(cell => cell.ch ?? " ").join("")).join("\n").includes(termText));
      await area(tab, "term.view");
      return shows(s, "term", tab, termText, diagnostic);
    } }],
    ["terminal", { ready: async (_, { tab }) => {
      await status(tab, "terminal.session", value => value.sessionId && value.cols > 0 && value.rows > 0);
      await s.run("terminal.input", { bytes: `printf '${terminalText}\\n'\r` }, tab);
      await status(tab, "terminal.screen", rows => rows.map(row => row.map(cell => cell.ch ?? " ").join("")).join("\n").includes(terminalText));
      await area(tab, "terminal.view");
      return shows(s, "terminal", tab, terminalText, diagnostic);
    } }],
  ]);
}
