// Host clock answers for the shared event batcher owner tests.
export const hostClock = { ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 };

// A batch request without its clock statement, which the batcher tests inspect separately.
export const withoutClock = (request) => (request?.action === "batch"
  ? { ...request, events: request.events.filter((event) => event.event !== "page.log.clock") } : request);
