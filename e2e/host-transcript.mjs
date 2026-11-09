// Reads the transcript lines of the host calls of the page: the requests and the replies per call name, and the layout that a drag or a
// resize settled at.
import { APPS } from "@soksak/window-check/app.mjs";
import { orderNames } from "@soksak/window-check/order-names.mjs";

const LINE = /^info workbench workbench: host (\w+) (\{.*\}|\[.*\]|null) -> (.*)$/;

/** Arranges the transcript lines into a list of requests and replies per call name. The id that differs per window is replaced by the order name,
 * and the configuration directory of each host, which holds the project root of the start values, by one name. */
export function transcript(lines) {
  const ordered = orderNames();
  const same = (text) => ordered(
    Object.values(APPS).reduce((result, app) => result.replaceAll(app.configDir, "<config-dir>"), text)
      .replace(/"ticket":\d+,/g, ""));
  const calls = new Map();
  for (const line of lines) {
    const found = LINE.exec(line);
    if (!found) continue;
    const [, name, request, answer] = found;
    if (!calls.has(name)) calls.set(name, []);
    calls.get(name).push({ request: same(request), answer: same(answer) });
  }
  return calls;
}

export const atRest = (calls) => {
  const prepared = [...(calls.get("syncSurfaces") ?? [])].reverse().find((c) => /"settled":true/.test(c.request));
  const presented = [...(calls.get("presentSurfaces") ?? [])].reverse().find((c) => /"settled":true/.test(c.request));
  return prepared && presented && { request: prepared.request, answer: presented.answer };
};

/** The x of the first surface for each layout request that the transcript settled. */
export const settledX = (lines) => (transcript(lines).get("syncSurfaces") ?? [])
  .filter((call) => /"settled":true/.test(call.request)).map((call) => JSON.parse(call.request).surfaces[0]?.x);

/** Orders surface frames by position: the drawing order of host.window and the order of a layout request are unrelated. */
export const byPosition = (a, b) => a.y - b.y || a.x - b.x;

/** Every surface frame that is visible and settled in the last layout request. */
export const settledFrames = (lines) => {
  const call = [...(transcript(lines).get("syncSurfaces") ?? [])].reverse()
    .find((entry) => /"settled":true/.test(entry.request));
  return call && JSON.parse(call.request).surfaces.filter((surface) => surface.visible)
    .map(({ x, y, w, h }) => ({ x, y, width: w, height: h })).sort(byPosition);
};

/** The line that says the page displayed the settled layout. */
export const settled = (lines) => lines.some((line) => /^info workbench workbench: host presentSurfaces .*"settled":true.* ->/.test(line));
