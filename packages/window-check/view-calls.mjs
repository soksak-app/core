// Finds the view calls that the page received and never answered in a list of host events (docs/spec/logging.md, the records
// page.view.call and page.view.reply that the workbench writes at the debug level, docs/spec/native-surfaces.md#view-surfaces).

/** The key that pairs a call with its reply: the page that sent the call, its plugin, its surface and its id. */
const keyOf = (event) => `${event.page}|${event.fields.plugin}|${event.fields.surface}|${event.fields.id}`;

/**
 * The view calls of events that have no reply. Each entry holds the plugin, surface, id and command of the call, the time that the
 * workbench received it and the time from that receipt to the last event of the list (waitingUs). A call with no reply at the
 * end of the list has not replied in the window that the events cover.
 */
export function unansweredViewCalls(events) {
  const replied = new Set();
  let lastUs = 0;
  for (const event of events) {
    lastUs = Math.max(lastUs, event.ts_us);
    if (event.event === "page.view.reply") replied.add(keyOf(event));
  }
  return events
    .filter((event) => event.event === "page.view.call" && !replied.has(keyOf(event)))
    .map((event) => ({
      plugin: event.fields.plugin,
      surface: event.fields.surface,
      id: event.fields.id,
      command: event.fields.command,
      receivedUs: event.ts_us,
      waitingUs: lastUs - event.ts_us,
    }));
}
