// Finds the view calls that the workbench received and neither answered nor canceled in a list of host events (docs/spec/logging.md,
// the workbench.view.call, workbench.view.reply and workbench.view.call.cancel records, docs/spec/native-surfaces.md#view-surfaces).

/** The key that pairs a call with its reply or cancellation: the start of its workbench, source generation, plugin, surface and id. */
const keyOf = (event) => `${event.start}|${event.fields.plugin}|${event.fields.surface}|${event.fields.generation}|${event.fields.id}`;

/**
 * The view calls of events that have no reply or cancellation. Each entry holds the plugin, surface, generation, id and command of the call, the time that the
 * workbench received it and the time from that receipt to the last event of the list (waitingUs). A call with no reply at the
 * end of the list has not replied in the window that the events cover.
 */
export function unansweredViewCalls(events) {
  const settled = new Set();
  let lastUs = 0;
  for (const event of events) {
    lastUs = Math.max(lastUs, event.ts_us);
    if (event.event === "workbench.view.reply" || event.event === "workbench.view.call.cancel") settled.add(keyOf(event));
  }
  return events
    .filter((event) => event.event === "workbench.view.call" && !settled.has(keyOf(event)))
    .map((event) => ({
      plugin: event.fields.plugin,
      surface: event.fields.surface,
      generation: event.fields.generation,
      id: event.fields.id,
      command: event.fields.command,
      receivedUs: event.ts_us,
      waitingUs: lastUs - event.ts_us,
    }));
}
