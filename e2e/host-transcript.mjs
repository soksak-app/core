// Reads the transcript lines of the host calls of the page: the requests and the replies per call name, and the layout that a drag or a
// resize settled at.
import { APPS } from "@soksak/window-check/app.mjs";
import { orderNames } from "@soksak/window-check/order-names.mjs";

const LINE = /^info workbench workbench: host (\w+) (\{.*\}|\[.*\]|null) -> (.*)$/;

/** The id that differs per window replaced by the order name, and the configuration directory of each host by one name. */
const sameText = (ordered) => (text) => ordered(
  Object.values(APPS).reduce((result, app) => result.replaceAll(app.configDir, "<config-dir>"), text));

/** The host calls of the transcript lines in their order, each as its name, request and answer. */
const calls = (lines) => lines.map((line) => LINE.exec(line)).filter(Boolean)
  .map(([, name, request, answer]) => ({ name, request, answer }));

/** Arranges the transcript lines into a list of requests and replies per call name. The id that differs per window is replaced by the order name,
 * the configuration directory of each host, which holds the project root of the start values, by one name, and the ticket is left out. */
export function transcript(lines) {
  const same = sameText(orderNames());
  const byName = new Map();
  for (const { name, request, answer } of calls(lines)) {
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ request: same(request.replace(/"ticket":\d+,/g, "")), answer: same(answer) });
  }
  return byName;
}

/**
 * The layouts that the transcript settled, in their order: for each presentation with settled true, the layout of the preparation that
 * it presents and its reply. A release after the preparation of the last layout presents that preparation as settled with no second
 * synchronization (docs/spec/native-surfaces.md), so a settled layout is the preparation before a settled presentation, with settled
 * true. A view sends its start values with the first preparation after they changed, which can be the settled one or an earlier one,
 * so the layout leaves out the start values of its surfaces and their declaration table, as the layout of the page does
 * (surfaceSyncRequestWithDeclarationTable), and the viewport, which places nothing. followed tells that a preparation came after the
 * presentation: the layout moved on.
 */
export function settledLayouts(lines) {
  const same = sameText(orderNames());
  const layouts = [];
  let prepared;
  for (const { name, request, answer } of calls(lines)) {
    if (name === "syncSurfaces") {
      prepared = JSON.parse(request);
      if (layouts.length) layouts.at(-1).followed = true;
    } else if (name === "presentSurfaces" && JSON.parse(request).settled === true && prepared) {
      const { declarations: _table, viewport: _viewport, ...rest } = prepared;
      const layout = { ...rest, settled: true, surfaces: prepared.surfaces.map(({ start: _start, ...item }) => item) };
      layouts.push({ layout, request: same(JSON.stringify(layout)), answer: same(answer), followed: false });
    }
  }
  return layouts;
}

/** The last layout that the transcript settled, as its request and the reply of its presentation, or undefined without one. */
export const atRest = (lines) => {
  const last = settledLayouts(lines).at(-1);
  return last && { request: last.request, answer: last.answer };
};

/** The x of the first surface for each layout that the transcript settled. */
export const settledX = (lines) => settledLayouts(lines).map(({ layout }) => layout.surfaces[0]?.x);

/** Orders surface frames by position: the drawing order of host.window and the order of a layout request are unrelated. */
export const byPosition = (a, b) => a.y - b.y || a.x - b.x;

/** The frames of the visible surfaces of a settled layout, by position. */
const framesOf = (settledLayout) => settledLayout && settledLayout.layout.surfaces.filter((surface) => surface.visible)
  .map(({ x, y, w, h }) => ({ x, y, width: w, height: h })).sort(byPosition);

/** Every surface frame that is visible in the last layout that the transcript settled. */
export const settledFrames = (lines) => framesOf(settledLayouts(lines).at(-1));

/** The frames of the last settled layout when no preparation followed its presentation, and undefined otherwise. */
export const restingFrames = (lines) => {
  const last = settledLayouts(lines).at(-1);
  return last && !last.followed ? framesOf(last) : undefined;
};

/** Whether the page presented a preparation of the transcript as settled. */
export const settled = (lines) => settledLayouts(lines).length > 0;
