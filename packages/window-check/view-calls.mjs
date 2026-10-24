// Finds the view calls that the page received and neither answered nor canceled in a list of host events (docs/spec/logging.md,
// the page.view.call, page.view.reply and page.view.call.cancel records, docs/spec/native-surfaces.md#view-surfaces).

/** The key that pairs a call with its reply or cancellation: its page, source generation, plugin, surface and id. */
const keyOf = (event) => `${event.page}|${event.fields.plugin}|${event.fields.surface}|${event.fields.generation}|${event.fields.id}`;

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
    if (event.event === "page.view.reply" || event.event === "page.view.call.cancel") settled.add(keyOf(event));
  }
  return events
    .filter((event) => event.event === "page.view.call" && !settled.has(keyOf(event)))
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
