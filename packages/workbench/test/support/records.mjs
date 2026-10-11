// Helpers of the tests that read the records of the page. A record of the page reaches the host as an event of a batch of
// the host call `log` (docs/spec/logging.md#writers); the tests read it as the record {level, where, text}.

/** The records {level, where, text} of the events of a host call `log`; none for another call. */
export function recordsOf(name, request) {
  if (name !== "log" || request.action !== "batch") return [];
  return request.events
    .filter((event) => event.event.startsWith("page.record."))
    .map((event) => ({ level: event.level, where: event.fields.where, text: event.fields.text }));
}

/** The clocks of the host as the request `{action: "clock"}` of the log call is answered; the batcher of the page needs this answer before its first batch. */
export const hostClock = { ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 };

/** The answer of a fake host to the clock request, or undefined when the call is another one. */
export const clockAnswer = (name, request) => (name === "log" && request?.action === "clock" ? hostClock : undefined);

/** A batch request without the statement of the anchor (page.log.clock), which leads the first batch of a page and has its own test in log-batch.test.mjs. */
export const withoutClock = (request) => (request?.action === "batch"
  ? { ...request, events: request.events.filter((event) => event.event !== "page.log.clock") } : request);

/** The record as the line `<level> page <where>: <text>`. */
export const shownRecord = (record) => `${record.level} page ${record.where}: ${record.text}`;

/** Waits until the batches that the page queued in this turn were relayed. */
export const settled = () => new Promise((resolve) => setImmediate(resolve));
