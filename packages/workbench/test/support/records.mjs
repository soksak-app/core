// Helpers of the tests that read the records of the page. A record of the page reaches the host as an event of a batch of
// the host call `log` (docs/spec/logging.md#writers); the tests read it as the record {level, where, text}.

/** The records {level, where, text} of the events of a host call `log`; none for another call. */
export function recordsOf(name, request) {
  if (name !== "log" || request.action !== "batch") return [];
  return request.events
    .filter((event) => event.event.startsWith("page.record."))
    .map((event) => ({ level: event.level, where: event.fields.where, text: event.fields.text }));
}

/** The record as the line `<level> page <where>: <text>`. */
export const shownRecord = (record) => `${record.level} page ${record.where}: ${record.text}`;

/** Waits until the batches that the page queued in this turn were relayed. */
export const settled = () => new Promise((resolve) => setImmediate(resolve));
