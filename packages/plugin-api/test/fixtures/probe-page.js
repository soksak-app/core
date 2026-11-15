// The page module of the view of the test plugin probe, built as a plugin page builds it: the bridge of the SDK over the sok-view
// handler of the window, two commands and a status. The module keeps the sidecar messages that its listener receives, and the
// reports of its bridge.
import { createExpose } from "@soksak/plugin-api";
import { createViewBridge } from "@soksak/plugin-api/view";

export const reports = [];
export const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: (event) => reports.push(event),
});

/** The sidecar messages of the session probe-surface, each as {body, cids}, in arrival order. */
export const sidecarMessages = [];

const expose = createExpose({
  register: bridge.exposure.register,
  reply: bridge.exposure.reply,
  changed: bridge.exposure.changed,
  report: (text) => bridge.runtime.error("probe exposure", text),
  onRequest: (listener) => bridge.runtime.native.on("exposure-request", listener),
}, () => window.sokSurface.declarations);

/** Resolves when the commands, the status and the sidecar listener of the page are registered with the host. */
export const ready = Promise.all([
  bridge.commands.register("probe.echo", (params) => ({ echo: params })),
  bridge.commands.register("probe.fail", () => { throw new Error("probe failed"); }),
  expose.status("probe.state", () => ({ ok: true }), () => () => {}),
  bridge.runtime.sidecar("fixture-sidecar").on("probe-surface", (body, cids) => sidecarMessages.push({ body, cids })),
]);
