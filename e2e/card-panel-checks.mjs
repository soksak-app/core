// Verdicts of the card panel window check. test/card-panel-checks.test.mjs checks that the verdicts reject invalid input.
import assert from "node:assert/strict";

/**
 * Display states that are missing from the recording. frames are { time, edges } (display time in ms, boundary coordinates measured in that frame) and poses are
 * { displayed, at } (display time in ms, boundary coordinates of that state). A state is missing when it is absent from the frames up to the first frame at or after two screen
 * frames from its display, or when no such frame exists. A frame stream promises no cadence, so the limit is that frame and not a time; each check bounds the recording gap itself.
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
  const until = (pose, index) => {
    const settled = start(pose, index) + window;
    return Math.min(...frames.filter((frame) => frame.time >= settled).map((frame) => frame.time), Infinity);
  };
  return poses.filter((pose, index) => !frames.some((frame) => frame.time >= after(index) &&
    frame.time <= until(pose, index) && frame.edges.some((edge) => Math.abs(edge - pose.at) <= 1)));
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
 * image is the result of readPng and ratio is device pixels / CSS pixels. The background is the colour that most pixels of the band show:
 * the band can hold the boundary line with the content at its edge and overlap the card border at its outer end, and a band at a
 * fractional device position puts that line within 2 points of the middle.
 */
export function gripInk(image, rect, ratio, threshold = 16) {
  const vertical = rect.height > rect.width;
  const from = Math.ceil((vertical ? rect.y : rect.x) * ratio);
  const to = Math.floor(((vertical ? rect.y + rect.height : rect.x + rect.width)) * ratio);
  const middle = Math.floor(((vertical ? rect.x + rect.width / 2 : rect.y + rect.height / 2)) * ratio);
  const across = [Math.ceil((vertical ? rect.x : rect.y) * ratio), Math.floor((vertical ? rect.x + rect.width : rect.y + rect.height) * ratio)];
  const counts = new Map();
  for (let at = from; at < to; at++) {
    for (let side = across[0]; side < across[1]; side++) {
      const key = (vertical ? image.pixel(side, at) : image.pixel(at, side)).join(",");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const background = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0].split(",").map(Number);
  let run = 0, longest = 0, total = 0, runs = 0, first = -1, last = -1;
  for (let at = from; at < to; at++) {
    const ink = (vertical ? image.pixel(middle, at) : image.pixel(at, middle)).some((value, index) => Math.abs(value - background[index]) > threshold);
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


/**
 * The rectangle that the native surface of a card's active tab must take in the window: the card inside its border, below the head and
 * above the foot, less the extent of each side (docs/spec/example-model.md). plane is the origin of the plane in the window, and metrics
 * holds border, head, foot and divider in points. An open side takes its shown size, which is smaller than its stored size when the card
 * cannot hold both that size and the layout minimum of the content.
 */
export function panelSurfaceRect(plane, card, metrics) {
  const { border, head, foot, divider } = metrics;
  const band = (side) => (card.sidebars?.[side] ? (card.sidebars[side].collapsed ? divider : card.sidebars[side].shownSize) : 0);
  return {
    x: plane.x + card.x + border + band("left"),
    y: plane.y + card.y + border + head + band("top"),
    w: card.w - 2 * border - band("left") - band("right"),
    h: card.h - 2 * border - head - foot - band("top") - band("bottom"),
  };
}
