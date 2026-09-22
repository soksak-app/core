import { startTerminal } from "./terminal.js";

const css = `:host{display:block;height:100%;background:transparent;color:var(--surface-fg)}#view{height:100%;outline:0}`;

export async function mount(root, context) {
  root.innerHTML = `<style>${css}</style><div id="view" data-expose="terminal.view" tabindex="0"></div>`;
  const view = root.querySelector("#view");
  const composition = await context.composition.create({ regions: { view }, overlays: {} });
  const image = composition.region("view");
  const sidecar = context.runtime.sidecar();
  const controller = await startTerminal({ id: context.surfaceId, view, attachImage: () => image, sidecar,
    expose: context.exposure, window, theme: context.runtime.theme });
  if (!controller || typeof controller.dispose !== "function") {
    throw new TypeError("startTerminal must return { dispose() }");
  }
  context.status.report("ready");
  return { focus: controller.focus, async dispose() {
    await controller.dispose();
    await composition.dispose();
    await context.exposure.dispose();
    root.replaceChildren();
  } };
}
