// The checker of the event contract (docs/spec/logging.md): it reads a log file of events and audits it against a catalog.
// A file that cannot be read as events is rejected with an error that names the file and the value found; an event that
// breaks the contract is a finding with its line.

/** The schema number that this checker reads. */
export const SCHEMA = 1;

const LEVELS = new Set(["error", "warn", "info", "debug", "trace"]);
const LAYERS = new Set(["native", "host", "page", "plugin", "sidecar"]);
const CLASSES = new Set(["lifecycle", "input", "call", "io", "frame"]);

/**
 * Reads the text of a log file into `{line, event}` entries. The first line must be `log.open` with the schema number
 * of this checker. A line that is not a JSON object is an error.
 */
export function parseLog(file, text) {
  const entries = [];
  const lines = text.split("\n").filter((line, index, all) => line !== "" || index < all.length - 1);
  lines.forEach((raw, index) => {
    const number = index + 1;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new Error(`${file}:${number}: not JSON: ${raw}`);
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(`${file}:${number}: not an event object: ${raw}`);
    }
    entries.push({ line: number, event });
  });
  const first = entries[0]?.event;
  if (first?.event !== "log.open") {
    throw new Error(`${file}: the first line is not log.open: ${entries.length === 0 ? "the file is empty" : JSON.stringify(first.event)}`);
  }
  if (first.fields?.schema !== SCHEMA) {
    throw new Error(`${file}: schema ${first.fields?.schema} is not ${SCHEMA}`);
  }
  return entries;
}

/** The type name of a value as the catalog spells it. */
function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** The findings of the structure of one event line. */
function lineFindings(entry, catalog) {
  const { line, event } = entry;
  const findings = [];
  const report = (message) => findings.push({ line, message });
  if (!Number.isInteger(event.seq)) report("seq must be an integer");
  if (!Number.isInteger(event.ts_us)) report("ts_us must be an integer");
  if (!LEVELS.has(event.level)) report(`level ${event.level} is not one of ${[...LEVELS].join(", ")}`);
  if (!LAYERS.has(event.layer)) report(`layer ${event.layer} is not one of ${[...LAYERS].join(", ")}`);
  const declared = catalog.events[event.event];
  if (declared === undefined) {
    if (event.undeclared !== true) report(`event ${event.event} is not declared`);
    return findings;
  }
  if (!CLASSES.has(declared.class)) report(`the catalog gives ${event.event} the class ${declared.class}`);
  for (const [name, type] of Object.entries(declared.fields)) {
    const value = event.fields?.[name];
    if (value === undefined) report(`field ${name} is required by ${event.event}`);
    else if (typeOf(value) !== type) report(`field ${name} must be a ${type}, found ${typeOf(value)}`);
  }
  return findings;
}

/** The ranges `[from, to]` of seq that `log.dropped` events of the file explain. */
function explainedRanges(entries) {
  return entries
    .filter(({ event }) => event.event === "log.dropped")
    .map(({ event }) => [event.fields.from_seq, event.fields.to_seq]);
}

/** The findings of the order of seq: consecutive, except for ranges that `log.dropped` names. */
function seqFindings(entries) {
  const ranges = explainedRanges(entries);
  const findings = [];
  let previous = null;
  for (const { line, event } of entries) {
    if (previous !== null && event.seq !== previous + 1) {
      const covered = ranges.some(([from, to]) => from === previous + 1 && to === event.seq - 1);
      if (!covered) findings.push({ line, message: `seq ${event.seq} follows seq ${previous}` });
    }
    previous = event.seq;
  }
  return findings;
}

/** The findings of the declared chains: each correlation identifier that starts a chain must reach its last event. */
function chainFindings(entries, catalog) {
  const findings = [];
  // 기본값: 사슬을 선언하지 않은 catalog 는 검사할 사슬이 없다.
  for (const [name, hops] of Object.entries(catalog.chains ?? {})) {
    const seen = new Map();
    for (const { line, event } of entries) {
      // 기본값: 입력에 속하지 않는 event 는 상관 식별자를 갖지 않는다.
      for (const cid of event.cids ?? []) {
        if (!seen.has(cid)) seen.set(cid, { line, events: new Set() });
        seen.get(cid).events.add(event.event);
      }
    }
    for (const [cid, { line, events }] of seen) {
      if (!events.has(hops[0])) continue;
      const missing = hops.find((hop) => !events.has(hop));
      if (missing !== undefined) findings.push({ line, message: `chain ${name} of ${cid} lacks ${missing}` });
    }
  }
  return findings;
}

/**
 * Audits the text of one log file against a catalog and returns the findings `{line, message}`: undeclared events,
 * missing or mistyped fields, gaps of seq that no `log.dropped` explains, and declared chains that stop early.
 */
export function auditLog(file, text, catalog) {
  const entries = parseLog(file, text);
  return [
    ...entries.flatMap((entry) => lineFindings(entry, catalog)),
    ...seqFindings(entries),
    ...chainFindings(entries, catalog),
  ].sort((a, b) => a.line - b.line);
}
