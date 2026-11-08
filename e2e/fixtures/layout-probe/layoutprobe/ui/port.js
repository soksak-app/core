// The exposure port of the layout probe views: registrations, replies and watched status values go through the view bridge.

/** The port that createExpose takes, made from the view bridge. */
export function probeExposurePort(bridge) {
  return {
    register: bridge.exposure.register,
    reply: bridge.exposure.reply,
    changed: bridge.exposure.changed,
    report: (text) => bridge.runtime.error("layoutprobe exposure", text),
    onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
  };
}
