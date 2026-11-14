// The view of the agent open probe (docs/spec/cli.md#acting-on-a-layout): in the place of the address and editing plugins, it
// reports the params of its tab, which core.layout.open and core.file.open give it (docs/spec/plugins.md), as the status
// agentopen.params. The params of a tab do not change while its view lives, so the status has one value.

/** The exposure port of the probe view: registrations, replies and watched status values go through the view bridge. */
export function probeExposurePort(bridge) {
  return {
    register: bridge.exposure.register,
    reply: bridge.exposure.reply,
    changed: bridge.exposure.changed,
    report: (text) => bridge.runtime.error("agentopen exposure", text),
    onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
  };
}

/** Starts the probe. expose is the exposure of the page and view the window of the view (its sokSurface). */
export async function startAgentOpen({ expose, view }) {
  const params = view.sokSurface.params;
  // The value never changes, so a watch receives no change.
  await expose.status("agentopen.params", () => params, () => () => {});
}
