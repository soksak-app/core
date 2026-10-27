// Reads plugin content from decoded recording pixels through the declared check executable.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FIXTURE } from "./hwp-support.mjs";

const run = promisify(execFile);

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
  assert.ok(width * height * 4 <= 64 * 1024 * 1024, "the view crop exceeds the 64 MiB recognition limit");
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    data.set(frame.data.subarray((y + row) * frame.stride + x * 4,
      (y + row) * frame.stride + (x + width) * 4), row * width * 4);
  }
  return { width, height, data };
}

export const normalizeViewText = text => text.normalize("NFC").replace(/\s/gu, "");

/** Reads text from one captured view frame without treating readiness as pixel evidence. */
export async function recognizeViewFrame({ frame, rect, language, directory, artifactName = "view-content",
  command = process.env.SOKSAK_CAPTURE_TEXT, runRecognition = run, removeScratch = rm }) {
  assert.ok(typeof language === "string" && language.length > 0, "view content recognition requires a language");
  assert.ok(typeof directory === "string" && directory.length > 0, "view content recognition requires a recording directory");
  assert.ok(typeof artifactName === "string" && /^[a-zA-Z0-9_-]+$/u.test(artifactName),
    "view content recognition requires a safe artifact name");
  assert.ok(typeof command === "string" && command.length > 0,
    "SOKSAK_CAPTURE_TEXT must name the built capture_text_test executable");
  assert.ok(typeof runRecognition === "function", "view content recognition requires a capture-text runner");
  assert.ok(typeof removeScratch === "function", "view content recognition requires a scratch cleanup operation");
  const crop = cropViewPixels(frame, rect);
  const scratchDirectory = await mkdtemp(join(tmpdir(), "soksak-view-content-"));
  const file = join(scratchDirectory, `${artifactName}.bgra.bin`);
  let recognitionFailed = false;
  let recognitionError;
  try {
    await writeFile(file, crop.data);
    const { stdout } = await runRecognition(command, ["--bgra", file, String(crop.width), String(crop.height),
      String(crop.width * 4), language], { timeout: 10000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    assert.ok(Array.isArray(result.lines) && result.lines.every(line => typeof line === "string"),
      `capture text recognition returned invalid lines for ${artifactName}`);
    return { ...result, crop: { width: crop.width, height: crop.height } };
  } catch (error) {
    recognitionFailed = true;
    recognitionError = error;
    throw error;
  } finally {
    try {
      await removeScratch(scratchDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      if (recognitionFailed) {
        throw new AggregateError([recognitionError, cleanupError],
          `view content recognition failed and its scratch directory could not be removed: ${scratchDirectory}`);
      }
      throw cleanupError;
    }
  }
}

/** Recognizes the final complete frame; readiness alone cannot satisfy the pixel assertion. */
function pixels(command, expected, language, diagnostic) {
  return async ({ captured, rect, directory }) => {
    const recognized = await recognizeViewFrame({ frame: captured.at(-1), rect, language, directory, command });
    const { crop, ...result } = recognized;
    writeFileSync(join(directory, "view-content.json"), JSON.stringify({ expected, language, ...result }, null, 2) + "\n");
    assert.ok(normalizeViewText(recognized.lines.join(" ")).includes(normalizeViewText(expected)),
      `captured view does not contain ${JSON.stringify(expected)}: ${JSON.stringify(recognized.lines)}`);
    diagnostic(`captured content ${JSON.stringify(expected)} in decoded frame ${captured.length}`);
  };
}

/** Declared per-plugin readiness and fixed captured-content expectations for the installed fixture. */
export async function viewContentCases(s, diagnostic) {
  const command = process.env.SOKSAK_CAPTURE_TEXT;
  assert.ok(typeof command === "string" && command.length > 0,
    "SOKSAK_CAPTURE_TEXT must name the built capture_text_test executable");
  const { root } = await s.get("core.project");
  const folder = `view-content-${process.pid}`;
  mkdirSync(join(root, folder));
  s.cleanup(() => rmSync(join(root, folder), { recursive: true, force: true }));
  const editorPath = `${folder}/content.txt`;
  const hwpPath = `${folder}/content.hwp`;
  const editorText = "SOKSAK EDITOR CONTENT";
  const terminalText = "SOKSAK TERMINAL CONTENT";
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
      return pixels(command, "주소를 입력하세요", "ko-KR", diagnostic);
    } }],
    ["editor", { params: { path: editorPath }, ready: async (_, { tab }) => {
      await status(tab, "editor.document", value => value.path === editorPath && value.length === editorText.length + 1);
      await area(tab, "editor.content");
      return pixels(command, editorText, "en-US", diagnostic);
    } }],
    ["hwp", { params: { path: hwpPath }, ready: async (_, { tab }) => {
      await status(tab, "hwp.document", value => value.path === hwpPath && value.phase === "ready" && value.pages === 1);
      await area(tab, "hwp.studio");
      return pixels(command, "속삭한글문서확인", "ko-KR", diagnostic);
    } }],
    ["terminal", { ready: async (_, { tab }) => {
      await status(tab, "terminal.session", value => value.sessionId && value.cols > 0 && value.rows > 0);
      await s.run("terminal.input", { bytes: `printf '${terminalText}\\n'\r` }, tab);
      await status(tab, "terminal.screen", rows => rows.map(row => row.map(cell => cell.ch ?? " ").join("")).join("\n").includes(terminalText));
      await area(tab, "terminal.view");
      return pixels(command, terminalText, "en-US", diagnostic);
    } }],
  ]);
}
