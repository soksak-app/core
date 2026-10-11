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

/**
 * The declaration of an event name. A catalog name with a placeholder such as `page.record.<level>` declares every event of
 * its family: a placeholder stands for one or more characters of `a-z`, `0-9`, `_` and `.`.
 */
function declaration(catalog, name) {
  if (catalog.events[name] !== undefined) return catalog.events[name];
  for (const [declared, value] of Object.entries(catalog.events)) {
    if (!declared.includes("<")) continue;
    const pattern = declared.split(/<[a-z_]+>/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9_.]+");
    if (new RegExp(`^${pattern}$`).test(name)) return value;
  }
  return undefined;
}

/** The findings of the structure of one event line. */
function lineFindings(entry, catalog) {
  const { line, event } = entry;
  const findings = [];
  // A catalog names the layers it owns; the events of another layer belong to the catalog of another repository.
  if (catalog.layers !== undefined && LAYERS.has(event.layer) && !catalog.layers.includes(event.layer)) return findings;
  const report = (message) => findings.push({ line, message });
  if (!Number.isInteger(event.seq)) report("seq must be an integer");
  if (!Number.isInteger(event.ts_us)) report("ts_us must be an integer");
  if (!LEVELS.has(event.level)) report(`level ${event.level} is not one of ${[...LEVELS].join(", ")}`);
  if (!LAYERS.has(event.layer)) report(`layer ${event.layer} is not one of ${[...LAYERS].join(", ")}`);
  const declared = declaration(catalog, event.event);
  if (declared === undefined) {
    if (event.undeclared !== true) report(`event ${event.event} is not declared`);
    return findings;
  }
  if (!CLASSES.has(declared.class)) report(`the catalog gives ${event.event} the class ${declared.class}`);
  // A field name that ends with `?` is optional, and a type such as `string|null` accepts each of its parts.
  for (const [declaredName, type] of Object.entries(declared.fields)) {
    const optional = declaredName.endsWith("?");
    const name = optional ? declaredName.slice(0, -1) : declaredName;
    const value = event.fields?.[name];
    if (value === undefined) {
      if (!optional) report(`field ${name} is required by ${event.event}`);
    } else if (!type.split("|").includes(typeOf(value))) report(`field ${name} must be a ${type}, found ${typeOf(value)}`);
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
  // default: a catalog that declares no chain has no chain to check.
  for (const [name, hops] of Object.entries(catalog.chains ?? {})) {
    const seen = new Map();
    for (const { line, event } of entries) {
      // default: an event that does not belong to the input has no correlation identifier.
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
