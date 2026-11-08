// The diagnostic module of the section view of the plain view probe, which diagnostics.json declares and a diagnostic build loads
// (docs/spec/plugins.md#diagnostic-declarations). The section view serves the entries of the section-view contract on its own surface
// (docs/spec/plugin-processes.md#section-views):
//   probeplain.view.frames {action}  start observes the content frames of the view document, paints its root with a marker color and
//                                    answers {enabled: true, sourceClock, markerColor}; stop ends both and answers {enabled: false}
//   probeplain.view.history          answers {length}, the number of entries of the session history of the view document
//   probeplain.section.view.ready    the status {ready, content} of the view: ready while the view shows the declared content
import { observeViewDocumentFrames } from "@soksak/plugin-api/diagnostic-view-frames";

/** The theme tokens of the card geometry that the benchmark tells apart from the marker: card, background and border colors. */
export const THEME_TOKENS = Object.freeze(["--card", "--bg", "--edge", "--rule", "--focus"]);
// The marker colors in order of preference. Each pair differs by 255 in a channel, so a theme color is within 4 of at most one of them
// in every channel, and the five theme colors leave at least one of the six free.
const MARKER_COLORS = Object.freeze([[255, 0, 255], [0, 255, 255], [255, 255, 0], [0, 255, 0], [255, 0, 0], [0, 0, 255]]);
const NEAR = 4;

/** The color of the theme token `token` on `root` as [r, g, b]; a value that is not #rrggbb is an error. */
function themeColor(view, root, token) {
  const value = view.getComputedStyle(root).getPropertyValue(token).trim();
  if (!/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new Error(`probeplain.view.frames requires the theme color ${token} as #rrggbb, not ${JSON.stringify(value)}`);
  }
  return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

/** The first marker color that differs from each theme color of the root of `view` by more than 4 in at least one channel. */
export function markerColorOf(view) {
  const root = view.document.documentElement;
  const colors = THEME_TOKENS.map((token) => themeColor(view, root, token));
  const marker = MARKER_COLORS.find((candidate) => colors.every((color) =>
    color.some((channel, index) => Math.abs(channel - candidate[index]) > NEAR)));
  if (!marker) throw new Error(`probeplain.view.frames found no marker color apart from the theme colors ${JSON.stringify(colors)}`);
  return [...marker];
}

/** The one string that the enum of the field `field` of the status `status` of `declaration` declares; another declaration is an error. */
export function declaredText(declaration, status, field) {
  const values = declaration?.exposes?.status?.find((entry) => entry.name === status)?.schema?.properties?.[field]?.enum;
  if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== "string") {
    throw new Error(`the diagnostic declaration of the probeplain section view gives ${status} no ${field} enum of one string`);
  }
  return values[0];
}

const hexOf = (rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

/**
 * Serves the section-view entries of the section view.
 *
 *   declaration     the diagnostic declaration of the start values, which declares the content of the status
 *   status          the name of the ready status of the view
 *   registerStatus  registers that status on the exposure of the page, with its read and its subscribe
 *   commands        the command registration of the view bridge
 *   view            the window of the view document
 *   content         the element of the view that shows the declared content
 *   log             the log of the view runtime, which records the content frames as plugin.probeplain.view.content_frame
 */
export async function attach({ declaration, status, registerStatus, commands, view, content, log }) {
  const text = declaredText(declaration, status, "content");
  const document = view.document;
  // The observation of the frames and the paint of the root while probeplain.view.frames is started, or null.
  let started = null;

  const start = () => {
    if (started !== null) throw new Error("probeplain.view.frames is already started");
    const markerColor = markerColorOf(view);
    const stop = observeViewDocumentFrames({
      document,
      log,
      ResizeObserver: view.ResizeObserver,
      requestAnimationFrame: view.requestAnimationFrame.bind(view),
      cancelAnimationFrame: view.cancelAnimationFrame.bind(view),
      now: view.performance.now.bind(view.performance),
      timeOriginMs: view.performance.timeOrigin,
    });
    // The paint is an adopted sheet of important declarations, so a theme message, which sets the tokens on the root as inline
    // declarations, does not replace it, and removing the sheet restores the paint of before the start.
    const hex = hexOf(markerColor);
    const paint = new view.CSSStyleSheet();
    paint.replaceSync(`:root{--card:${hex} !important;background-color:${hex} !important}`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, paint];
    started = { stop, paint };
    const sourceClock = { documentTimeOriginMs: view.performance.timeOrigin, sourceNowMs: view.performance.now(), sourceResolutionMs: 1 };
    return { enabled: true, sourceClock, markerColor };
  };

  const stop = () => {
    if (started === null) throw new Error("probeplain.view.frames is not started");
    const { stop: stopFrames, paint } = started;
    started = null;
    stopFrames();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== paint);
    return { enabled: false };
  };

  // The element is read at each value, so a view that no longer shows the declared text reports ready false.
  const ready = () => ({ ready: content.isConnected && !content.hidden && content.textContent === text, content: text });

  await Promise.all([
    registerStatus(ready, (listener) => {
      const observer = new view.MutationObserver(() => listener(ready()));
      observer.observe(content, { attributes: true, attributeFilter: ["hidden"], characterData: true, childList: true, subtree: true });
      return () => observer.disconnect();
    }),
    commands.register("probeplain.view.frames", async ({ action } = {}) => {
      if (action === "start") return start();
      if (action === "stop") return stop();
      throw new TypeError("probeplain.view.frames action must be start or stop");
    }),
    commands.register("probeplain.view.history", async () => {
      const length = view.history.length;
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new Error(`probeplain.view.history read an invalid session history length ${JSON.stringify(length)}`);
      }
      return { length };
    }),
  ]);
}
