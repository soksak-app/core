import { startTerminal } from "./terminal.js";

// 스크롤바는 네이티브 그림 위의 DOM overlay 다. 뷰 오른쪽 가장자리에 놓는다.
const css = `:host{display:block;height:100%;background:transparent;color:var(--surface-fg);position:relative}#view{height:100%;outline:0}
#scrollbar{position:absolute;top:0;right:0;bottom:0;width:10px}#scrollbar[hidden]{display:none}
#thumb{position:absolute;left:2px;right:2px;border-radius:3px;background:color-mix(in srgb,var(--surface-fg) 45%,transparent);cursor:default}`;

export async function mount(root, context) {
  root.innerHTML = `<style>${css}</style><div id="view" data-expose="terminal.view" tabindex="0"></div>` +
    `<div id="scrollbar" hidden><div id="thumb"></div></div>`;
  const view = root.querySelector("#view");
  const scrollbar = { track: root.querySelector("#scrollbar"), thumb: root.querySelector("#thumb") };
  const composition = await context.composition.create({ regions: { view }, overlays: { scrollbar: scrollbar.track } });
  const image = composition.region("view");
  const sidecar = context.runtime.sidecar();
  let controller;
  try {
    controller = await startTerminal({ id: context.surfaceId, view, attachImage: () => image, sidecar, scrollbar,
      expose: context.exposure, window, theme: context.runtime.theme, settings: context.runtime.settings,
      textSize: context.runtime.textSize,
      reportSurfaceError: (error) => context.status.report("error", error),
      diagnostics: context.diagnostics,
      clipboard: context.runtime.clipboard });
    if (!controller || typeof controller.dispose !== "function") {
      throw new TypeError("startTerminal must return { dispose() }");
    }
  } catch (error) {
    try {
      await composition.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "terminal mount and composition cleanup failed");
    }
    throw error;
  }
  context.status.report("ready");
  return { focus: controller.focus, async dispose() {
    await controller.dispose();
    await composition.dispose();
    await context.exposure.dispose();
    root.replaceChildren();
  } };
}
