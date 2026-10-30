// The node:test reporter that the test runner reads (docs/operations/examples.md#test-runner). It writes one line per test event to the
// standard error, prefixed by EVENT_PREFIX, so the runner resets the event watchdog of the file at each event. The other lines of the
// standard error are the TAP form, which the runner keeps as the output of the file.
export const EVENT_PREFIX = "@soksak-test-event ";

export default async function* testEvents(source) {
  for await (const event of source) {
    if (!event.type.startsWith("test:")) continue;
    const name = typeof event.data?.name === "string" ? event.data.name : "";
    yield `${EVENT_PREFIX}${JSON.stringify({ type: event.type, name })}\n`;
  }
}
