// The entry of the section view of the plain view probe: it connects the view bridge and the exposure of the page and, in a diagnostic
// build, serves the section-view entries of its diagnostic module (diagnostics.json), whose ready status reads the text of #content.
import { createExpose } from "@soksak/plugin-api";
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
const expose = createExpose({
  register: bridge.exposure.register, reply: bridge.exposure.reply, changed: bridge.exposure.changed,
  report: (text) => bridge.runtime.error("probeplain exposure", text),
  onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
}, () => window.sokSurface.declarations);
const start = window.sokSurface;
if (!Object.hasOwn(start, "diagnostics")) {
  throw new Error("the start values of the probeplain section view have no diagnostics member");
}
// A build without diagnostics gives null, and the view then loads no diagnostic module.
if (start.diagnostics !== null) {
  // The module path of the declaration is relative to the root of the plugin, the folder above this file.
  const { attach } = await import(new URL(`../${start.diagnostics.module}`, import.meta.url).href);
  const status = `${start.section.id}.view.ready`;
  await attach({
    declaration: start.diagnostics,
    status,
    registerStatus: (read, subscribe) => expose.status(status, read, subscribe),
    commands: bridge.commands,
    view: window,
    content: document.getElementById("content"),
    log: bridge.runtime.log,
  });
}
