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
  // The writer stores an event over its size bound cut: `truncated` is the size of the fields before the cut, and the fields
  // hold only the head of their text, so the declared fields are not asked for (docs/spec/logging.md#bounds).
  if (event.truncated !== undefined) {
    if (!Number.isInteger(event.truncated) || event.truncated <= 0) report("truncated must be a positive integer");
    else if (typeof event.fields?.head !== "string") report("the fields of a truncated event must hold the string head");
    return findings;
  }
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
    for (const { line, file, event } of entries) {
      // default: an event that does not belong to the input has no correlation identifier.
      for (const cid of event.cids ?? []) {
        if (!seen.has(cid)) seen.set(cid, { line, file, events: new Set() });
        seen.get(cid).events.add(event.event);
      }
    }
    for (const [cid, { line, file, events }] of seen) {
      if (!events.has(hops[0])) continue;
      const missing = hops.find((hop) => !events.has(hop));
      if (missing !== undefined) findings.push({ line, file, message: `chain ${name} of ${cid} lacks ${missing}` });
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

/** The process a file belongs to and its position in the order of the generations: `host-1-2.jsonl.1` and `host-1-2.debug.jsonl` belong to `host-1-2`. */
export function processOf(file) {
  const base = file.split("/").pop();
  const match = /^(.+?)(?:\.debug)?\.jsonl(?:\.\d+)?$/.exec(base);
  if (match === null) throw new Error(`${file}: not an event file name (<role>-<boot>[.debug].jsonl[.<generation>])`);
  return match[1];
}

/** The text of an `error` event for a finding. */
function errorText(event) {
  // default: a line may carry no fields, which the structure check reports on its own; the text then names the event.
  const { where, text } = event.fields ?? {};
  // default: the same absent fields give the empty record in the text of an event that has no where and text.
  return typeof where === "string" && typeof text === "string" ? `${where}: ${text}` : `${event.event}: ${JSON.stringify(event.fields ?? {})}`;
}

/**
 * Audits the event files of one configuration folder together and returns the findings `{file, line, message}`. `logs` is
 * `[{file, text}]` for every layer and generation. Each line is checked against the catalog. The `seq` of one process is
 * consecutive across its rotated generations and its debug file (gaps that `log.dropped` names are explained), the declared
 * chains join the events of all files because a chain crosses processes, and an `error` event is a finding unless
 * `declaredError(file, {line, event})` is true.
 */
export function auditLogs(logs, catalog, declaredError = () => false) {
  const parsed = logs.map(({ file, text }) => ({ file, process: processOf(file), entries: parseLog(file, text).map((entry) => ({ ...entry, file })) }));
  return auditParsed(parsed, catalog, declaredError);
}

/** The audit of `auditLogs` for files that are already read: `[{file, process, entries}]` with `file` on each entry. */
export function auditParsed(parsed, catalog, declaredError = () => false) {
  const findings = [];
  const located = (file, list) => list.forEach(({ line, message }) => findings.push({ file, line, message }));
  for (const { file, entries } of parsed) {
    located(file, entries.flatMap((entry) => lineFindings(entry, catalog)));
    for (const entry of entries) {
      if (entry.event.level === "error" && !declaredError(file, entry)) {
        findings.push({ file, line: entry.line, message: `undeclared error ${errorText(entry.event)}` });
      }
    }
    // seq increases within one file; the merge below checks the continuity of the process.
    entries.forEach((entry, index) => {
      if (index > 0 && entry.event.seq <= entries[index - 1].event.seq) {
        findings.push({ file, line: entry.line, message: `seq ${entry.event.seq} follows seq ${entries[index - 1].event.seq}` });
      }
    });
  }
  const processes = new Map();
  // default: the first file of a process has no entries collected yet.
  for (const { process, entries } of parsed) processes.set(process, [...(processes.get(process) ?? []), ...entries]);
  for (const entries of processes.values()) {
    const ordered = [...entries].sort((a, b) => a.event.seq - b.event.seq);
    const ranges = explainedRanges(ordered);
    ordered.forEach((entry, index) => {
      const previous = ordered[index - 1];
      if (previous === undefined || entry.event.seq === previous.event.seq + 1) return;
      // A file whose seq runs backwards is already reported above.
      if (previous.file === entry.file && entry.event.seq < previous.event.seq) return;
      const covered = ranges.some(([from, to]) => from === previous.event.seq + 1 && to === entry.event.seq - 1);
      if (!covered) findings.push({ file: entry.file, line: entry.line, message: `seq ${entry.event.seq} follows seq ${previous.event.seq}` });
    });
  }
  const all = parsed.flatMap(({ entries }) => entries);
  for (const { line, message, file } of chainFindings(all, catalog)) findings.push({ file, line, message });
  const order = new Map(parsed.map(({ file }, index) => [file, index]));
  // default: findings of the same file, or of a file without an order, are ordered by their line.
  return findings.sort((a, b) => order.get(a.file) - order.get(b.file) || a.line - b.line);
}
