// Verdicts of the card panel window check. test/card-panel-checks.test.mjs checks that the verdicts reject invalid input.
import assert from "node:assert/strict";

/**
 * Display states that are missing from the recording. frames are { time, edges } (display time in ms, boundary coordinates measured in that frame) and poses are
 * { displayed, at } (display time in ms, boundary coordinates of that state). When no frame that holds the boundary exists within two screen frames after a state is displayed,
 * the recording was not made at the requested rate.
 */
export function missingPoses(frames, poses, refreshRate) {
  assert.ok(Number.isFinite(refreshRate) && refreshRate > 0, `the display refresh rate is unknown (${refreshRate})`);
  const window = 2000 / refreshRate;
  // There is no frame before the recording starts. A state that was displayed before the recording started and did not change until the first frame is counted from the first frame.
  // A state that changed to the next state before the recording started cannot be recorded, so it is counted from its original time.
  const first = Math.min(...frames.map((frame) => frame.time));
  const start = (pose, index) => {
    const next = poses[index + 1];
    const replaced = next !== undefined && next.displayed < first;
    return pose.displayed < first && !replaced ? first : pose.displayed;
  };
  // The reported display time can be later than the refresh in which the state first appeared on screen (host.window.presented is the refresh
  // after the reply). So the check looks at the frames from the display of the previous state to two screen frames after the display of this state. Frames before the previous state
  // was displayed record an earlier state.
  const after = (index) => (index === 0 ? -Infinity : poses[index - 1].displayed - 1);
  return poses.filter((pose, index) => !frames.some((frame) => frame.time >= after(index) &&
    frame.time <= start(pose, index) + window && frame.edges.some((edge) => Math.abs(edge - pose.at) <= 1)));
}

/** Fails when a panel remains after all panels are turned off. A remaining default panel fails as well. */
export function requireCleared(sidebars) {
  const left = Object.keys(sidebars);
  assert.deepEqual(left, [], `panels remained after clearing: ${left.join(", ")}`);
}

/**
 * The pair of tabs for the tab switch check. It looks in card or in another card for a tab of a plugin other than the active tab of card. When it finds one in another card,
 * from holds the id of that card. It fails when no tab of another plugin exists, because the check cannot run.
 */
export function tabSwitchPair(card, cards) {
  const original = card.tabs.find((tab) => tab.id === card.active);
  const own = card.tabs.find((tab) => tab.plugin !== original.plugin);
  if (own) return { original, other: own, from: card.id };
  const source = cards.find((item) => item.id !== card.id && item.tabs.some((tab) => tab.plugin !== original.plugin));
  assert.ok(source, `no tab of a plugin other than ${original.plugin} exists for the tab switch`);
  return { original, other: source.tabs.find((tab) => tab.plugin !== original.plugin), from: source.id };
}

/**
 * The DOM width of a top or bottom panel must equal the content column width of the card (the inner width of the card minus the width that the left and right sidebars occupy)
 * (docs/spec/example-model.md). A collapsed face occupies the divider width.
 */
export function requireContentWidth(rect, card, border, divider, side) {
  // default: a face that does not exist occupies no width.
  const extent = (state) => (state ? (state.collapsed ? divider : state.shownSize) : 0);
  const column = card.w - 2 * border - extent(card.sidebars?.left) - extent(card.sidebars?.right);
  assert.ok(Math.abs(rect.width - column) <= 1, `${side} panel is ${rect.width} wide, not the card's content column width ${column}`);
}

/**
 * Inside the collapsed card panel grip rectangle (CSS pixels), along the center line of the long axis, the longest run of pixels that differ from the background inside the band,
 * its pixel count, the number of continuous runs (runs), and the length from the first ink to the last ink (span) (device pixels).
 * image is the result of readPng and ratio is device pixels / CSS pixels.
 */
export function gripInk(image, rect, ratio, threshold = 16) {
  const vertical = rect.height > rect.width;
  const from = Math.ceil((vertical ? rect.y : rect.x) * ratio);
  const to = Math.floor(((vertical ? rect.y + rect.height : rect.x + rect.width)) * ratio);
  const middle = Math.floor(((vertical ? rect.x + rect.width / 2 : rect.y + rect.height / 2)) * ratio);
  // The outer end of the band can overlap the card border, so a pixel inside the band at 2 CSS pixels from the center is used as the background.
  const edge = middle - Math.round(2 * ratio);
  let run = 0, longest = 0, total = 0, runs = 0, first = -1, last = -1;
  for (let at = from; at < to; at++) {
    const [x, y, ex, ey] = vertical ? [middle, at, edge, at] : [at, middle, at, edge];
    const ink = image.pixel(x, y).some((value, index) => Math.abs(value - image.pixel(ex, ey)[index]) > threshold);
    if (ink && run === 0) runs++;
    run = ink ? run + 1 : 0;
    longest = Math.max(longest, run);
    if (ink) {
      total++;
      if (first < 0) first = at;
      last = at;
    }
  }
  return { longest, total, runs, span: first < 0 ? 0 : last - first + 1, length: to - from };
}

