import assert from "node:assert/strict";
import test from "node:test";

import {
  BLANK_PER_POINT, caseInput, colourAt, dividerOf, formatReport, missingFrames, parseOptions, screenRows, textBands, textLines, textProfile,
  zeroRows,
} from "../measure-terminal-resize.mjs";

/** The screen rows of `lines`, one cell for each character. */
const rows = (...lines) => lines.map((line) => [...line].map((ch) => ({ ch, width: 1 })));

/** A frame of `width` by `height` points at scale 2, filled with `fill` ([r, g, b]), in the form of readFrame. */
function frameOf(width, height, fill) {
  const scale = 2;
  const stride = width * scale * 4;
  const data = Buffer.alloc(stride * height * scale);
  for (let at = 0; at < data.length; at += 4) {
    data[at] = fill[2];
    data[at + 1] = fill[1];
    data[at + 2] = fill[0];
  }
  return { width: width * scale, height: height * scale, stride, content: { x: 0, y: 0, width, height }, contentScale: 1, scale, data };
}

/** Paints the rectangle of window points x0..x1, y0..y1 of `frame` with `colour`. */
function paint(frame, { x0, x1, y0, y1 }, colour) {
  for (let y = y0 * frame.scale; y < y1 * frame.scale; y++) {
    for (let x = x0 * frame.scale; x < x1 * frame.scale; x++) {
      const at = y * frame.stride + x * 4;
      frame.data[at] = colour[2];
      frame.data[at + 1] = colour[1];
      frame.data[at + 2] = colour[0];
    }
  }
}

const BACKGROUND = [25, 27, 35];
const GAP = [16, 17, 23];

test("the options name the configuration directory, the plugin and known cases", () => {
  assert.deepEqual(parseOptions(["--config-dir", "/c", "--plugin", "p"]),
    { configDir: "/c", plugin: "p", cases: ["prompt", "output", "alt"], distance: 200, ms: 900, times: 2, json: false });
  assert.deepEqual(parseOptions(["--config-dir", "/c", "--plugin", "p", "--cases", "alt", "--distance", "80"]).cases, ["alt"]);
  assert.throws(() => parseOptions(["--config-dir", "c", "--plugin", "p"]), /--config-dir must be an absolute path \(c\)/);
  assert.throws(() => parseOptions(["--config-dir", "/c", "--plugin", "p", "--cases", "vim"]), /--cases holds vim/);
  assert.throws(() => parseOptions(["--config-dir", "/c", "--plugin", "p", "--times", "0"]), /--times must be a positive integer \(0\)/);
  assert.throws(() => parseOptions(["--config-dir", "/c"]), /required options/);
});

test("each case ends with a line that the echoed command line does not hold", () => {
  const prompt = caseInput("prompt", "/r");
  assert.equal(prompt.shown(screenRows(rows("% clear; echo hello; printf '%s-%s\\n' resize prompt"))), false);
  assert.equal(prompt.shown(screenRows(rows("hello", "resize-prompt", "% "))), true);
  const output = caseInput("output", "/r");
  assert.equal(output.shown(screenRows(rows("200", "resize-output"))), false);
  assert.equal(output.shown(screenRows(rows("200", "0000", "00", "resize-output", "% "))), true);
  assert.match(caseInput("alt", "/r").bytes, /^clear; less "\/r\/resize-lines\.txt"\n$/);
  assert.equal(caseInput("alt", "/r").shown(screenRows(rows("line 1: the quick"))), true);
  assert.throws(() => caseInput("vim", "/r"), /unknown case vim/);
  assert.equal(textLines(2), "line 1: the quick brown fox jumps over the lazy dog 1\nline 2: the quick brown fox jumps over the lazy dog 2\n");
});

test("the rows of zeros keep their lengths in their order", () => {
  assert.deepEqual(zeroRows(["170", "000", "00", "0x0", "", "0"]), [3, 2, 1]);
});

test("the divider is the first run of the gap colour of at least four points", () => {
  const frame = frameOf(100, 20, BACKGROUND);
  paint(frame, { x0: 40, x1: 43, y0: 0, y1: 20 }, GAP);
  paint(frame, { x0: 50, x1: 56, y0: 0, y1: 20 }, GAP);
  assert.deepEqual(colourAt(frame, 51, 10), GAP);
  assert.deepEqual(dividerOf(frame, { y: 10, from: 0, to: 100, gap: GAP }), { start: 50, end: 56 });
  assert.equal(dividerOf(frame, { y: 10, from: 60, to: 100, gap: GAP }), null);
  assert.throws(() => colourAt(frame, 100, 10), /outside the frame/);
});

test("text pixels differ from the background and coloured text pixels have spread channels", () => {
  const frame = frameOf(40, 20, BACKGROUND);
  paint(frame, { x0: 2, x1: 4, y0: 2, y1: 4 }, [220, 220, 220]);
  paint(frame, { x0: 6, x1: 7, y0: 2, y1: 3 }, [120, 200, 240]);
  paint(frame, { x0: 2, x1: 4, y0: 8, y1: 9 }, [220, 220, 220]);
  const { profile, coloured } = textProfile(frame, { x0: 0, x1: 40, y0: 0, y1: 10, background: BACKGROUND });
  assert.deepEqual(profile, [0, 0, 0, 0, 6, 6, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 0, 0]);
  assert.equal(coloured, 4);
  assert.deepEqual(textBands(profile, 1), [{ start: 4, end: 8 }, { start: 16, end: 18 }]);
  assert.deepEqual(textBands(profile, 9), [{ start: 4, end: 18 }]);
});

test("a prompt frame misses text below the share of coloured pixels, and an alt frame when a band turns blank", () => {
  const blank = BLANK_PER_POINT * 4;
  const frames = [
    { bands: [400, 300], coloured: 1000 },
    null,
    { bands: [400, 300], coloured: 450 },
    { bands: [0, 300], coloured: 150 },
    { bands: [400, 25], coloured: 1000 },
  ];
  assert.deepEqual(missingFrames("prompt", frames, blank), { judged: true, missing: [3] });
  assert.deepEqual(missingFrames("output", frames, blank), { judged: true, missing: [3] });
  assert.deepEqual(missingFrames("alt", frames, blank), { judged: true, missing: [3] });
  assert.deepEqual(missingFrames("alt", [{ bands: [400, 10], coloured: 0 }, { bands: [400, 0], coloured: 0 }], blank), { judged: true, missing: [] });
  assert.deepEqual(missingFrames("prompt", [{ bands: [400], coloured: 3 }, { bands: [0], coloured: 0 }], blank), { judged: false, missing: [] });
  assert.throws(() => missingFrames("prompt", [null], blank), /no frame of the recording shows the divider/);
});

test("the report names each case, terminal and a wrapped line that does not join", () => {
  const report = formatReport({
    plugin: "p", distance: 200, ms: 900, times: 2,
    results: [{
      name: "output", folder: "/f", notes: ["lost 1"], took: 3600, asked: 3600, frames: 450, moves: 300, withoutDivider: 0,
      terminals: [
        { tab: "t1", bands: 30, judged: true, missing: [1, 2], zerosBefore: [57, 15], zerosAfter: [57, 15] },
        { tab: "t2", bands: 30, judged: false, missing: [], zerosBefore: [57, 15], zerosAfter: [57, 10, 5] },
      ],
    }],
  });
  assert.equal(report, [
    "p: divider 200 points left and back 2 times, 900 ms each way",
    "output: 450 frames, 300 divider moves, 0 without the divider, drag 3600 ms of 3600 ms; /f",
    "  recording: lost 1",
    "  left t1: 2 frames miss text (first 1, 2), 30 text bands, zero rows [57,15] -> [57,15]",
    "  right t2: not judged (no coloured prompt), 30 text bands, zero rows [57,15] -> [57,10,5] NOT REJOINED",
  ].join("\n"));
});
